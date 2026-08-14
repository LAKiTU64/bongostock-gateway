import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface WatchlistGroup {
  id: string
  name: string
  codes: string[]
}

export interface WatchlistState {
  version: 1
  groups: WatchlistGroup[]
  names: Record<string, string>
}

export const MAX_WATCHLIST_GROUPS = 8
export const MAX_WATCHLIST_SIZE = 300
export const MAX_GROUP_NAME_LENGTH = 20

function normalizeCode(value: string) {
  const code = value.trim().toUpperCase()

  if (!/^\d{6}$/.test(code)) return code
  if (/^[56]/.test(code)) return `SH${code}`
  if (/^[0-3]/.test(code)) return `SZ${code}`

  return code
}

export function isValidCode(value: string) {
  return /^(?:SH|SZ)\d{6}$/.test(normalizeCode(value))
}

function normalizeGroupName(value: string) {
  return value.trim().slice(0, MAX_GROUP_NAME_LENGTH)
}

function randomId() {
  return randomBytes(4).toString('hex')
}

function emptyState(): WatchlistState {
  return { version: 1, groups: [], names: {} }
}

function sanitizeGroups(values: readonly unknown[]): WatchlistGroup[] {
  const result: WatchlistGroup[] = []
  const seenIds = new Set<string>()
  const seenCodes = new Set<string>()

  for (const entry of values.slice(0, MAX_WATCHLIST_GROUPS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const group = entry as Record<string, unknown>
    const id = typeof group.id === 'string' && group.id && !seenIds.has(group.id) ? group.id : randomId()
    const name = normalizeGroupName(typeof group.name === 'string' ? group.name : '') || '自选股'
    const codes: string[] = []
    const groupCodes = new Set<string>()

    seenIds.add(id)

    for (const rawCode of Array.isArray(group.codes) ? group.codes : []) {
      const code = normalizeCode(String(rawCode ?? ''))
      if (!isValidCode(code) || groupCodes.has(code)) continue
      if (!seenCodes.has(code) && seenCodes.size >= MAX_WATCHLIST_SIZE) continue

      groupCodes.add(code)
      seenCodes.add(code)
      codes.push(code)
    }

    result.push({ id, name, codes })
  }

  return result
}

function sanitizeState(value: unknown): WatchlistState {
  const state = emptyState()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return state

  const raw = value as Record<string, unknown>
  state.groups = sanitizeGroups(Array.isArray(raw.groups) ? raw.groups : [])

  const rawNames = raw.names && typeof raw.names === 'object' && !Array.isArray(raw.names)
    ? raw.names as Record<string, unknown>
    : {}
  for (const [code, name] of Object.entries(rawNames)) {
    if (isValidCode(code) && typeof name === 'string' && name.trim()) {
      state.names[normalizeCode(code)] = name.trim().slice(0, 40)
    }
  }

  return state
}

export class WatchlistError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message)
  }
}

export class WatchlistStore {
  private state = emptyState()
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly resolveName: (code: string) => Promise<string | undefined>,
  ) {}

  async load() {
    if (this.loaded) return

    try {
      const text = await readFile(this.filePath, 'utf8')
      this.state = sanitizeState(JSON.parse(text) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A corrupt file must not take the service down. Log and start empty.
        process.stderr.write(`watchlist: 无法读取 ${this.filePath}: ${error instanceof Error ? error.message : String(error)}\n`)
      }
      this.state = emptyState()
    }

    this.loaded = true
  }

  async getState(): Promise<WatchlistState> {
    await this.load()
    return structuredClone(this.state)
  }

  private async persist() {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.tmp`
    const body = JSON.stringify(this.state, null, 2)
    await writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 })
    await rename(tmpPath, this.filePath)
  }

  private async mutate(change: (state: WatchlistState) => void) {
    await this.load()
    const before = structuredClone(this.state)
    change(this.state)
    const snapshot = structuredClone(this.state)
    try {
      // Serialize writes so concurrent requests never interleave temp files.
      this.writeQueue = this.writeQueue.then(() => this.persist())
      await this.writeQueue
    } catch (error) {
      // Persist failure must not leave a half-applied state in memory, nor a
      // rejected queue that blocks every later write.
      this.state = before
      this.writeQueue = Promise.resolve()
      throw error
    }
    return snapshot
  }

  async addGroup(rawName: string) {
    await this.load()
    const name = normalizeGroupName(rawName)
    if (!name) throw new WatchlistError('请输入分组名称')
    if (this.state.groups.length >= MAX_WATCHLIST_GROUPS) {
      throw new WatchlistError(`最多创建 ${MAX_WATCHLIST_GROUPS} 个分组`)
    }
    if (this.state.groups.some(group => group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new WatchlistError('已经有同名分组')
    }

    return this.mutate(state => {
      state.groups.push({ id: randomId(), name, codes: [] })
    })
  }

  async removeGroup(id: string) {
    await this.load()
    if (this.state.groups.length <= 1) throw new WatchlistError('至少保留一个分组')
    const target = this.state.groups.find(group => group.id === id)
    if (!target) throw new WatchlistError('分组不存在', 404)

    return this.mutate(state => {
      state.groups = state.groups.filter(group => group.id !== id)
    })
  }

  async addCode(groupId: string, rawCode: string) {
    await this.load()
    const code = normalizeCode(rawCode)
    const target = this.state.groups.find(group => group.id === groupId)

    if (!isValidCode(code)) throw new WatchlistError('请输入 6 位代码，或 SH600036 / SZ000858')
    if (!target) throw new WatchlistError('请选择一个分组', 404)
    if (target.codes.includes(code)) throw new WatchlistError('这个代码已经在当前分组中')

    const allCodes = new Set(this.state.groups.flatMap(group => group.codes))
    if (!allCodes.has(code) && allCodes.size >= MAX_WATCHLIST_SIZE) {
      throw new WatchlistError(`自选列表最多保存 ${MAX_WATCHLIST_SIZE} 只股票或基金`)
    }

    const resolvedName = await this.resolveName(code)

    return this.mutate(state => {
      const group = state.groups.find(item => item.id === groupId)
      if (!group) return
      if (group.codes.includes(code)) return
      group.codes.push(code)
      if (resolvedName) state.names[code] = resolvedName
    })
  }

  /**
   * Replace the whole watchlist with the given groups (full overwrite for
   * client-side sync). Unknown names are resolved on demand; names for codes
   * that no longer exist are dropped.
   */
  async replaceGroups(rawGroups: unknown) {
    await this.load()
    if (!Array.isArray(rawGroups)) throw new WatchlistError('groups 必须是数组')

    const groups = sanitizeGroups(rawGroups)
    const keptCodes = new Set(groups.flatMap(group => group.codes))
    const unknownCodes = [...keptCodes].filter(code => !this.state.names[code])

    // Resolve names for new codes, batching one code at a time like addCode.
    const resolved = new Map<string, string>()
    await Promise.all(unknownCodes.map(async (code) => {
      const name = await this.resolveName(code)
      if (name) resolved.set(code, name)
    }))

    return this.mutate(state => {
      state.groups = groups
      for (const code of Object.keys(state.names)) {
        if (!keptCodes.has(code)) delete state.names[code]
      }
      for (const [code, name] of resolved) {
        state.names[code] = name
      }
    })
  }

  async removeCode(groupId: string, rawCode: string) {
    await this.load()
    const code = normalizeCode(rawCode)

    return this.mutate(state => {
      const group = state.groups.find(item => item.id === groupId)
      if (!group) return
      group.codes = group.codes.filter(item => item !== code)
    })
  }
}
