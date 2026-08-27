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
  /** Server-side timestamp (ms) of the last write, set in mutate(). */
  updatedAt: number
  groups: WatchlistGroup[]
  names: Record<string, string>
}

/**
 * A point-in-time snapshot of the whole watchlist, kept for rollback.
 * Semantics are like save-game slots: after every successful write a snapshot
 * of the NEW state is appended (newest first), and `restore(updatedAt)` rolls
 * the current state back to a chosen snapshot. Restoring is itself a write,
 * so it advances `updatedAt` and existing clients pick the rollback up via
 * their normal pull.
 */
export interface WatchlistSnapshot {
  /** When the snapshot itself was recorded (Date.now(), ms). */
  savedAt: number
  /** The `updatedAt` value the snapshot was taken from. Used to select it. */
  updatedAt: number
  groups: WatchlistGroup[]
  names: Record<string, string>
}

export const MAX_WATCHLIST_SNAPSHOTS = 10

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
  return { version: 1, updatedAt: 0, groups: [], names: {} }
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
  if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) && raw.updatedAt > 0) {
    state.updatedAt = raw.updatedAt
  }

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
  private snapshots: WatchlistSnapshot[] = []
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly resolveName: (code: string) => Promise<string | undefined>,
  ) {}

  /** Companion file holding rollback snapshots, e.g. watchlist.backup.json. */
  private backupFilePath() {
    return this.filePath.endsWith('.json')
      ? `${this.filePath.slice(0, -5)}.backup.json`
      : `${this.filePath}.backup.json`
  }

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

    try {
      const text = await readFile(this.backupFilePath(), 'utf8')
      const raw = JSON.parse(text) as { snapshots?: unknown }
      if (Array.isArray(raw.snapshots)) {
        this.snapshots = raw.snapshots
          .filter((entry): entry is WatchlistSnapshot => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
            const snapshot = entry as Record<string, unknown>
            return typeof snapshot.savedAt === 'number'
              && typeof snapshot.updatedAt === 'number'
              && Array.isArray(snapshot.groups)
          })
          .slice(0, MAX_WATCHLIST_SNAPSHOTS)
      }
    } catch (error) {
      // Missing or corrupt backup is fine: only rollback history is lost.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`watchlist: 备份快照无法读取: ${error instanceof Error ? error.message : String(error)}\n`)
      }
      this.snapshots = []
    }

    this.loaded = true
  }

  async getState(): Promise<WatchlistState> {
    await this.load()
    return structuredClone(this.state)
  }

  async listBackups(): Promise<WatchlistSnapshot[]> {
    await this.load()
    return structuredClone(this.snapshots)
  }

  private async persist() {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.tmp`
    const body = JSON.stringify(this.state, null, 2)
    await writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 })
    await rename(tmpPath, this.filePath)

    // Rollback snapshot: record the NEW state (newest first), cap at 10.
    // This must not fail the primary write — wrap in its own try/catch.
    const snapshot: WatchlistSnapshot = {
      savedAt: Date.now(),
      updatedAt: this.state.updatedAt,
      groups: structuredClone(this.state.groups),
      names: structuredClone(this.state.names),
    }
    try {
      const snapshots = [snapshot, ...this.snapshots].slice(0, MAX_WATCHLIST_SNAPSHOTS)
      const backupPath = this.backupFilePath()
      const backupTmp = `${backupPath}.tmp`
      await writeFile(backupTmp, JSON.stringify({ version: 1, snapshots }, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(backupTmp, backupPath)
      this.snapshots = snapshots
    } catch (error) {
      process.stderr.write(`watchlist: 备份快照写入失败（不影响主数据）: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  private async mutate(change: (state: WatchlistState) => void) {
    await this.load()
    const before = structuredClone(this.state)
    change(this.state)
    // Strictly monotonic: Date.now() alone can repeat within the same
    // millisecond, which would break clients' `since` change detection.
    this.state.updatedAt = Math.max(Date.now(), this.state.updatedAt + 1)
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
   *
   * When `baseUpdatedAt` is provided it acts as an optimistic lock: if the
   * state changed after that timestamp, the write is rejected with 409 so the
   * caller can re-pull instead of silently overwriting newer cloud data.
   */
  async replaceGroups(rawGroups: unknown, baseUpdatedAt?: number) {
    await this.load()
    if (!Array.isArray(rawGroups)) throw new WatchlistError('groups 必须是数组')
    // 空状态可被任意覆盖（没有有效数据会丢失）；仅当云端已有数据时校验乐观锁。
    const hasExistingData = this.state.groups.length > 0 || Object.keys(this.state.names).length > 0
    if (hasExistingData && typeof baseUpdatedAt === 'number' && Number.isFinite(baseUpdatedAt) && this.state.updatedAt > baseUpdatedAt) {
      throw new WatchlistError('云端已有更新，请刷新后重试', 409)
    }

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

  /**
   * Roll the whole watchlist back to a recorded snapshot (save-game restore).
   * The target snapshot is selected by its `updatedAt`. Restoring is itself a
   * write, so the state's `updatedAt` advances afterwards — clients that pull
   * with `since` will detect the change and re-sync to the restored data.
   * Throws WatchlistError(404) when no snapshot matches.
   */
  async restore(updatedAt: number) {
    await this.load()
    const target = this.snapshots.find(snapshot => snapshot.updatedAt === updatedAt)
    if (!target) throw new WatchlistError('找不到对应的存档点', 404)

    const groups = sanitizeGroups(target.groups)
    const names: Record<string, string> = {}
    for (const [code, name] of Object.entries(target.names)) {
      if (isValidCode(code) && typeof name === 'string' && name.trim()) {
        names[normalizeCode(code)] = name.trim().slice(0, 40)
      }
    }

    return this.mutate(state => {
      state.groups = groups
      state.names = names
    })
  }
}
