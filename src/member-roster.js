/**
 * 群成员名册缓存：open_id → 姓名，小群成员并集 → 助教/老师。
 *
 * channel 启动后与每 6 小时调飞书「获取群成员列表」，把登记群聊的成员
 * 写进 <historyDir>/members.json；夜间整理只读这份文件，把历史条目里的
 * open_id 渲染成「用户 张三」「助教/老师 李四」。拉取失败（如应用缺
 * im:chat.members:read 权限）只记日志，旧名册继续用，不影响答疑与整理。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { historyDir } from './history-store.js'

/** 名册刷新间隔；成员变化不频繁，六小时足够。 */
export const MEMBER_REFRESH_MS = 6 * 3_600_000

const FILE_NAME = 'members.json'
const MAX_PAGES = 20
const PAGE_SIZE = 100

export function rosterPath() {
  return join(historyDir(), FILE_NAME)
}

export function emptyRoster() {
  return { version: 1, updatedAt: 0, chats: {}, staffOpenIds: [], staffNames: [] }
}

export function normalizeRoster(raw) {
  const out = emptyRoster()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  out.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
  if (raw.chats !== null && typeof raw.chats === 'object' && !Array.isArray(raw.chats)) {
    for (const [chatId, chat] of Object.entries(raw.chats)) {
      if (chat === null || typeof chat !== 'object') continue
      const members = []
      for (const member of Array.isArray(chat.members) ? chat.members : []) {
        const openId = typeof member?.openId === 'string' ? member.openId.trim() : ''
        if (openId === '') continue
        const name = typeof member?.name === 'string' ? member.name.trim() : ''
        members.push({ openId, name })
      }
      out.chats[chatId] = {
        fetchedAt: Number.isFinite(chat.fetchedAt) ? chat.fetchedAt : 0,
        members,
      }
    }
  }
  out.staffOpenIds = uniqueStrings(raw.staffOpenIds)
  out.staffNames = uniqueStrings(raw.staffNames)
  return out
}

export function readRoster() {
  try {
    return normalizeRoster(JSON.parse(fs.readFileSync(rosterPath(), 'utf8')))
  } catch {
    return emptyRoster()
  }
}

export async function saveRoster(roster) {
  const file = rosterPath()
  await fsp.mkdir(historyDir(), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(temp, `${JSON.stringify(roster, null, 2)}\n`, { mode: 0o600 })
  await fsp.rename(temp, file)
  await fsp.chmod(file, 0o600).catch(() => undefined)
}

/** 查名册用的索引；姓名缺失（外部成员等）时保持 open_id 在册，角色仍可判定。 */
export function rosterIndex(roster) {
  const nameById = new Map()
  for (const chat of Object.values(roster.chats)) {
    for (const member of chat.members) {
      if (member.name !== '') nameById.set(member.openId, member.name)
    }
  }
  return {
    nameById,
    staffOpenIds: new Set(roster.staffOpenIds),
    staffNames: [...roster.staffNames],
  }
}

/** 拉取一个群的全部成员（open_id + 姓名）；翻页失败直接抛出，交给调用方降级。 */
export async function fetchChatMembers(client, chatId) {
  const members = []
  let pageToken = ''
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = { member_id_type: 'open_id', page_size: PAGE_SIZE }
    if (pageToken !== '') params.page_token = pageToken
    const res = await client.request({
      method: 'GET',
      url: `/open-apis/im/v1/chats/${chatId}/members`,
      params,
    })
    if (typeof res?.code === 'number' && res.code !== 0) {
      throw new Error(`Lark API ${res.code}: ${res.msg ?? ''}`)
    }
    const data = res?.data ?? res
    const items = Array.isArray(data?.items) ? data.items : []
    for (const item of items) {
      const openId = typeof item?.member_id === 'string' ? item.member_id.trim() : ''
      if (openId === '') continue
      const name = typeof item?.name === 'string' ? item.name.trim() : ''
      members.push({ openId, name })
    }
    if (data?.has_more === true && typeof data?.page_token === 'string' && data.page_token !== '') {
      pageToken = data.page_token
      continue
    }
    break
  }
  return members
}

/**
 * 合并一次拉取结果：成功的群覆盖，失败的群保留旧数据；
 * 助教/老师集合始终按小群名册重算（小群拉取失败时沿用旧名册）。
 */
export function mergeRoster(previous, fetchedByChat, managerChatIds) {
  const chats = { ...previous.chats }
  let updated = 0
  for (const [chatId, members] of fetchedByChat) {
    chats[chatId] = { fetchedAt: Date.now(), members }
    updated += 1
  }
  const staffOpenIds = []
  const staffNames = []
  for (const chatId of managerChatIds) {
    for (const member of chats[chatId]?.members ?? []) {
      staffOpenIds.push(member.openId)
      if (member.name !== '') staffNames.push(member.name)
    }
  }
  return {
    version: 1,
    updatedAt: updated === 0 ? previous.updatedAt : Date.now(),
    chats,
    staffOpenIds: uniqueStrings(staffOpenIds),
    staffNames: uniqueStrings(staffNames),
  }
}

function uniqueStrings(value) {
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}
