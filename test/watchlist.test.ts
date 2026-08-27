import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import test from 'node:test'

import { WatchlistStore, MAX_WATCHLIST_GROUPS, MAX_WATCHLIST_SIZE } from '../src/watchlist.js'

async function withStore(run: (store: WatchlistStore, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'bongostock-watchlist-'))
  const store = new WatchlistStore(join(dir, 'watchlist.json'), async (code) => {
    if (code === 'SH600036') return '招商银行'
    if (code === 'SZ000858') return '五粮液'
    if (code === 'SH000001') return '上证指数'
    return undefined
  })
  try {
    await run(store, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('starts empty and persists to disk', async () => {
  await withStore(async (store, dir) => {
    const empty = await store.getState()
    assert.equal(empty.version, 1)
    assert.equal(empty.updatedAt, 0)
    assert.deepEqual(empty.groups, [])
    assert.deepEqual(empty.names, {})

    const afterAdd = await store.addGroup('自选股')
    assert.equal(afterAdd.groups.length, 1)
    assert.equal(afterAdd.groups[0]?.name, '自选股')
    assert.ok(afterAdd.updatedAt > 0)

    const reloaded = new WatchlistStore(join(dir, 'watchlist.json'), async () => undefined)
    const state = await reloaded.getState()
    assert.equal(state.groups.length, 1)
    assert.equal(state.groups[0]?.codes.length, 0)
    assert.equal(state.updatedAt, afterAdd.updatedAt)
  })
})

test('normalizes codes and resolves names', async () => {
  await withStore(async (store) => {
    const state = await store.addGroup('自选股')
    const groupId = state.groups[0]!.id

    const withCode = await store.addCode(groupId, '600036')
    assert.equal(withCode.groups[0]?.codes[0], 'SH600036')
    assert.equal(withCode.names['SH600036'], '招商银行')

    const padded = await store.addCode(groupId, 'SH000001')
    assert.equal(padded.groups[0]?.codes[1], 'SH000001')
    assert.equal(padded.names['SH000001'], '上证指数')
  })
})

test('rejects duplicate code within a group', async () => {
  await withStore(async (store) => {
    const state = await store.addGroup('自选股')
    const groupId = state.groups[0]!.id
    await store.addCode(groupId, 'SH600036')
    await assert.rejects(() => store.addCode(groupId, '600036'), /已经在当前分组/)
  })
})

test('rejects invalid codes and missing groups', async () => {
  await withStore(async (store) => {
    const state = await store.addGroup('自选股')
    const groupId = state.groups[0]!.id

    await assert.rejects(() => store.addCode(groupId, 'abc'), /6 位代码/)
    await assert.rejects(() => store.addCode('missing', 'SH600036'), /请选择一个分组/)
  })
})

test('enforces group name rules', async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.addGroup('  '), /请输入分组名称/)
    await store.addGroup('自选股')
    await assert.rejects(() => store.addGroup('自选股'), /同名分组/)

    for (let index = 0; index < MAX_WATCHLIST_GROUPS - 1; index += 1) {
      await store.addGroup(`分组${index}`)
    }
    await assert.rejects(() => store.addGroup('超出的分组'), /最多创建/)
  })
})

test('removes groups and codes', async () => {
  await withStore(async (store) => {
    const first = (await store.addGroup('第一组')).groups[0]!
    const second = (await store.addGroup('第二组')).groups[1]!
    const withCode = await store.addCode(first.id, 'SH600036')

    const removed = await store.removeCode(first.id, 'SH600036')
    assert.equal(removed.groups[0]?.codes.length, 0)

    const afterGroupDelete = await store.removeGroup(first.id)
    assert.equal(afterGroupDelete.groups.length, 1)
    assert.equal(afterGroupDelete.groups[0]?.id, second.id)

    await assert.rejects(() => store.removeGroup(second.id), /至少保留一个分组/)
  })
})

test('deduplicates codes across groups up to the size limit', async () => {
  await withStore(async (store) => {
    const groupA = (await store.addGroup('组A')).groups[0]!
    const groupB = (await store.addGroup('组B')).groups[1]!

    for (let index = 0; index < MAX_WATCHLIST_SIZE; index += 1) {
      const code = `SH${String(600000 + index)}`
      await store.addCode(groupA.id, code)
    }

    // 同一证券可以跨组，但整体去重后不得超过上限。
    const state = await store.addCode(groupB.id, 'SH600036')
    assert.equal(state.groups[1]?.codes.length, 1)
    await assert.rejects(() => store.addCode(groupB.id, 'SH610000'), /最多保存/)
  })
})

test('tolerates a corrupt file by starting empty', async () => {
  await withStore(async (store, dir) => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'watchlist.json'), '{not valid json', 'utf8')
    const state = await store.getState()
    assert.deepEqual(state.groups, [])
  })
})

test('rolls back memory state when persist fails', async () => {
  const { writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'bongostock-watchlist-ro-'))
  // Occupy the parent path with a regular file so mkdir fails with ENOTDIR
  // even when running as root (chmod-based read-only dirs do not stop root).
  const blocker = join(dir, 'blocker')
  await writeFile(blocker, 'not a directory', 'utf8')
  const store = new WatchlistStore(join(blocker, 'watchlist.json'), async () => undefined)
  await assert.rejects(() => store.addGroup('自选股'), /EEXIST|ENOTDIR|file already exists|not a directory/i)
  // The failed mutation must not be visible, and a later write must still work.
  const dir2 = join(dir, 'ok')
  const store2 = new WatchlistStore(join(dir2, 'watchlist.json'), async () => undefined)
  await store2.addGroup('自选股')
  const after = await store2.addGroup('第二个组')
  assert.equal(after.groups.length, 2)
  await rm(dir, { recursive: true, force: true })
})

test('replaces the whole watchlist and drops stale names', async () => {
  await withStore(async (store) => {
    const state = await store.addGroup('自选股')
    await store.addCode(state.groups[0]!.id, 'SH600036')
    await store.addCode(state.groups[0]!.id, 'SZ000858')

    const replaced = await store.replaceGroups([
      { id: 'fresh', name: '全新分组', codes: ['SH600519', '600036'] },
    ])
    assert.equal(replaced.groups.length, 1)
    assert.equal(replaced.groups[0]?.name, '全新分组')
    assert.deepEqual(replaced.groups[0]?.codes, ['SH600519', 'SH600036'])
    assert.equal(replaced.names['SZ000858'], undefined)
    assert.equal(replaced.names['SH600519'], undefined)
    // 重新解析后的名称：600036 仍能解析，600519 未知。
    assert.equal(replaced.names['SH600036'], '招商银行')
  })
})

test('replace rejects non-array groups', async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.replaceGroups({ groups: [] }), /groups 必须是数组/)
  })
})

test('replace enforces the size limit of 300 deduplicated codes', async () => {
  await withStore(async (store) => {
    const codes = Array.from({ length: MAX_WATCHLIST_SIZE }, (_, index) => `SH${String(600000 + index)}`)
    await store.replaceGroups([{ id: 'big', name: '大组', codes }])
    const state = await store.getState()
    assert.equal(state.groups[0]?.codes.length, MAX_WATCHLIST_SIZE)
    // 300 只以内可以再加一只；满额后再加被拒绝。
    await assert.rejects(() => store.addCode('big', 'SH610000'), /最多保存 300/)
  })
})

test('updatedAt advances on every write and loads from disk', async () => {
  await withStore(async (store, dir) => {
    const first = await store.addGroup('自选股')
    await new Promise(resolve => setTimeout(resolve, 2))
    const second = await store.addCode(first.groups[0]!.id, 'SH600036')

    assert.ok(second.updatedAt > first.updatedAt)

    const reloaded = new WatchlistStore(join(dir, 'watchlist.json'), async () => undefined)
    const state = await reloaded.getState()
    assert.equal(state.updatedAt, second.updatedAt)
  })
})

test('replace accepts a matching baseUpdatedAt and rejects a stale one with 409', async () => {
  await withStore(async (store) => {
    const baseline = await store.addGroup('自选股')
    const baseUpdatedAt = baseline.updatedAt

    // 相同的 baseUpdatedAt 允许覆盖。
    const accepted = await store.replaceGroups([{ id: 'a', name: 'A', codes: ['SH600036'] }], baseUpdatedAt)
    assert.equal(accepted.groups[0]?.name, 'A')

    // 过期 baseUpdatedAt（已被上面那次写操作推进）被拒绝。
    await assert.rejects(
      () => store.replaceGroups([{ id: 'b', name: 'B', codes: [] }], baseUpdatedAt),
      (error) => error instanceof Error && error.message.includes('云端已有更新') && 'statusCode' in error && error.statusCode === 409,
    )
  })
})

test('replace allows overwriting an empty cloud state regardless of baseUpdatedAt', async () => {
  await withStore(async (store) => {
    // 云端为空（从未写入或刚清空）时，任意 baseUpdatedAt 都可覆盖，
    // 保证"本地有数据、云端还没同步过"的首次迁移不被 409 卡住。
    const state = await store.replaceGroups([{ id: 'seed', name: '迁移数据', codes: ['SH600036'] }], 0)
    assert.equal(state.groups[0]?.name, '迁移数据')
    assert.ok(state.updatedAt > 0)
  })
})

test('legacy file without updatedAt loads as zero', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bongostock-watchlist-legacy-'))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dir, 'watchlist.json'), JSON.stringify({ version: 1, groups: [], names: {} }), 'utf8')
  const store = new WatchlistStore(join(dir, 'watchlist.json'), async () => undefined)
  const state = await store.getState()
  assert.equal(state.updatedAt, 0)
  await rm(dir, { recursive: true, force: true })
})

test('records a snapshot after every write and caps at 10', async () => {
  await withStore(async (store) => {
    const state = await store.addGroup('自选股')
    for (let index = 0; index < 12; index += 1) {
      await store.addCode(state.groups[0]!.id, `SH${String(600000 + index)}`)
    }
    const backups = await store.listBackups()
    assert.equal(backups.length, 10)
    // 最新的快照在最前（含 12 次 addCode 的完整结果）。
    assert.equal(backups[0]?.groups[0]?.codes.length, 12)
    assert.equal(backups.at(-1)?.groups[0]?.codes.length, 3)
    assert.ok(backups[0]!.savedAt >= backups.at(-1)!.savedAt)
  })
})

test('restore rolls back to a snapshot and advances updatedAt', async () => {
  await withStore(async (store) => {
    const first = await store.addGroup('自选股')
    await store.addCode(first.groups[0]!.id, 'SH600036')
    const second = await store.addGroup('第二组')

    const target = (await store.listBackups()).find(snapshot => snapshot.groups.length === 1 && snapshot.groups[0]!.name === '自选股')
    assert.ok(target)

    const restored = await store.restore(target!.updatedAt)
    assert.equal(restored.groups.length, 1)
    assert.equal(restored.groups[0]?.codes[0], 'SH600036')
    // 回滚本身也是一次写操作，updatedAt 继续前进（让客户端能拉取到回滚结果）。
    assert.ok(restored.updatedAt > second.updatedAt)
  })
})

test('restore rejects an unknown snapshot with 404', async () => {
  await withStore(async (store) => {
    await store.addGroup('自选股')
    await assert.rejects(
      () => store.restore(123456),
      (error) => error instanceof Error && 'statusCode' in error && error.statusCode === 404,
    )
  })
})

test('backup file survives reload', async () => {
  await withStore(async (store, dir) => {
    await store.addGroup('自选股')
    const reloaded = new WatchlistStore(join(dir, 'watchlist.json'), async () => undefined)
    const backups = await reloaded.listBackups()
    assert.equal(backups.length, 1)
    assert.equal(backups[0]?.groups[0]?.name, '自选股')
  })
})
