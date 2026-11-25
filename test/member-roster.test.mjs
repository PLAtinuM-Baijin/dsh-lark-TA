import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureHistory, readHistoryEntries, recordMessage } from '../src/history-store.js'
import {
  emptyRoster,
  mergeRoster,
  normalizeRoster,
  readRoster,
  rosterIndex,
  rosterPath,
  saveRoster,
} from '../src/member-roster.js'

function tempHistory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-roster-'))
  configureHistory({ dir, authoritative: true })
  return dir
}

test('normalizeRoster 容忍缺失与脏数据', () => {
  const roster = normalizeRoster({
    updatedAt: 12,
    chats: {
      oc_a: { fetchedAt: 3, members: [{ openId: 'ou_a', name: ' 张三 ' }, { openId: '' }, null] },
      oc_bad: 'nope',
    },
    staffOpenIds: ['ou_a', 'ou_a', 7],
    staffNames: ['张三', ''],
  })
  assert.equal(roster.updatedAt, 12)
  assert.deepEqual(roster.chats.oc_a.members, [{ openId: 'ou_a', name: '张三' }])
  assert.equal(roster.chats.oc_bad, undefined)
  assert.deepEqual(roster.staffOpenIds, ['ou_a'])
  assert.deepEqual(roster.staffNames, ['张三'])
})

test('mergeRoster 保留拉取失败的群，并按小群重算助教/老师', () => {
  const previous = normalizeRoster({
    chats: { oc_old: { fetchedAt: 1, members: [{ openId: 'ou_old', name: '旧成员' }] } },
  })
  const next = mergeRoster(
    previous,
    new Map([
      [
        'oc_ta',
        [
          { openId: 'ou_t1', name: '韩梅梅' },
          { openId: 'ou_t2', name: '' },
        ],
      ],
      ['oc_class', [{ openId: 'ou_s1', name: '李雷' }]],
    ]),
    ['oc_ta'],
  )
  assert.deepEqual(next.chats.oc_old.members, [{ openId: 'ou_old', name: '旧成员' }])
  assert.deepEqual(next.chats.oc_ta.members.length, 2)
  assert.deepEqual(next.staffOpenIds, ['ou_t1', 'ou_t2'])
  assert.deepEqual(next.staffNames, ['韩梅梅'])
  assert.ok(next.updatedAt > 0)
})

test('rosterIndex 把姓名映射到 open_id', () => {
  const roster = normalizeRoster({
    chats: {
      oc_class: { fetchedAt: 1, members: [{ openId: 'ou_s1', name: '李雷' }, { openId: 'ou_t1', name: '' }] },
    },
    staffOpenIds: ['ou_t1'],
  })
  const index = rosterIndex(roster)
  assert.equal(index.nameById.get('ou_s1'), '李雷')
  assert.equal(index.nameById.has('ou_t1'), false)
  assert.equal(index.staffOpenIds.has('ou_t1'), true)
})

test('history 条目保存并读回发言人 open_id', () => {
  tempHistory()
  recordMessage('oc_test', { id: 'om_1', at: 100, from: 'user', text: '你好', sender: 'ou_a' })
  recordMessage('oc_test', { id: 'om_2', at: 200, from: 'bot', text: '你好呀' })
  const entries = readHistoryEntries('oc_test')
  assert.equal(entries[0].sender, 'ou_a')
  assert.equal('sender' in entries[1], false)
})

test('名册文件原子写入并读回', async () => {
  tempHistory()
  const roster = { ...emptyRoster(), updatedAt: 42, staffNames: ['张三'] }
  await saveRoster(roster)
  assert.equal(path.basename(rosterPath()), 'members.json')
  assert.equal(readRoster().updatedAt, 42)
  assert.deepEqual(readRoster().staffNames, ['张三'])
})
