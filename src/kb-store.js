/**
 * 助教经验知识库的 Markdown 存储层。
 *
 * 目录结构（TA_KB_DIR，默认 <TA_WORKSPACE>/kb）：
 *   <主题>.md   自由格式 Markdown，按主题分文件
 *
 * 知识库只收可复用的助教经验（配环境、工具链报错、提交流程……），
 * 不收 C++ 学科知识、不收学生私聊、不收未发布的题目答案。
 * 文件名即主题；内容没有固定版式，由夜间整理会话自行组织、合并。
 *
 * 写入走模块级串行队列 + 临时文件 rename；读按文件直读，文件很小。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TOPIC = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u
const MAX_FILE_BYTES = 32 * 1024
/** 单次 read 返回的字符上限，超出截断；整理员需要全文时可以分主题精简。 */
export const READ_LIMIT = 20000

function defaultDir() {
  const fromEnv = typeof process.env.TA_KB_DIR === 'string' ? process.env.TA_KB_DIR.trim() : ''
  if (fromEnv !== '') return fromEnv
  const workspace = typeof process.env.TA_WORKSPACE === 'string' ? process.env.TA_WORKSPACE.trim() : ''
  return workspace === '' ? path.join(os.homedir(), '.dsh-lark-ta-kb') : path.join(workspace, 'kb')
}

let rootDir = defaultDir()
let writeChain = Promise.resolve()

export function kbDir() {
  return rootDir
}

export function setKbDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return
  rootDir = dir.trim()
}

export function isValidTopic(topic) {
  return typeof topic === 'string' && TOPIC.test(topic)
}

function topicFile(topic) {
  return path.join(rootDir, `${topic}.md`)
}

function enqueue(task) {
  const run = writeChain.then(task, task)
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** 主题清单（含首行摘要），按最近修改倒序。 */
export async function listTopics() {
  let names
  try {
    names = await fs.readdir(rootDir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const match = /^(.+)\.md$/.exec(name)
    if (match === null || !isValidTopic(match[1])) continue
    const file = path.join(rootDir, name)
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) continue
      const head = await fs.readFile(file, 'utf8')
      const firstLine = head.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
      out.push({
        topic: match[1],
        bytes: stat.size,
        updatedAt: stat.mtimeMs,
        preview: firstLine === undefined ? '' : firstLine.replace(/^#+\s*/, ''),
      })
    } catch {
      // 恰好被删掉的文件直接跳过。
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function readTopic(topic) {
  if (!isValidTopic(topic)) throw new Error('无效的主题名')
  let text
  try {
    text = await fs.readFile(topicFile(topic), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, text: '', bytes: 0 }
    throw error
  }
  return { exists: true, text, bytes: Buffer.byteLength(text, 'utf8') }
}

export async function writeTopic(topic, text, { append = false } = {}) {
  if (!isValidTopic(topic)) {
    throw new Error('无效的主题名：只能用中文/字母/数字/下划线/连字符，最长 40 字')
  }
  if (typeof text !== 'string' || text.trim() === '') throw new Error('知识库内容为空')
  const body = text.replace(/\r\n/g, '\n').trim()

  return enqueue(async () => {
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 })
    const file = topicFile(topic)
    let next = body
    let created = true
    if (append) {
      let existing = ''
      try {
        existing = await fs.readFile(file, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      created = existing.trim() === ''
      next = created ? body : `${existing.replace(/\n*$/, '')}\n\n${body}`
    }
    next = `${next}\n`
    const bytes = Buffer.byteLength(next, 'utf8')
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`主题「${topic}」会超过 ${MAX_FILE_BYTES / 1024}KB 上限：先 read 再合并、精简后写入`)
    }
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await fs.writeFile(tmp, next, { mode: 0o600 })
    await fs.rename(tmp, file)
    await fs.chmod(file, 0o600).catch(() => undefined)
    return { topic, bytes, created }
  })
}

export async function deleteTopic(topic) {
  if (!isValidTopic(topic)) throw new Error('无效的主题名')
  return enqueue(async () => {
    try {
      await fs.unlink(topicFile(topic))
      return { removed: true }
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: false }
      throw error
    }
  })
}
