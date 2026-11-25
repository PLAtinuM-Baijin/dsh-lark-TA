/**
 * ta-fs 的路径作用域实现（不依赖 dsh 包，便于单独测试）。
 *
 * dsh 原生 fs 工具没有读根配置，fs-sandbox 也只限制写。助教实例要求
 * 模型只能读课程目录、只能写工作区，所以每个入口都先 realpath，
 * 再用 path.relative 做包含检查；遍历时拒绝跟随符号链接。
 */
import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

const SKIP_DIRS = new Set(['.git', 'node_modules'])
const MAX_WALK_DEPTH = 32

export function createPathScope(options = {}) {
  const readRoots = []
  for (const raw of Array.isArray(options.readRoots) ? options.readRoots : []) {
    const root = resolveRoot(raw)
    if (root !== '' && !readRoots.includes(root)) readRoots.push(root)
  }
  const writeRoot = resolveRoot(options.writeRoot)
  const maxReadBytes = positiveInt(options.maxReadBytes, 262144)
  const maxReadLines = positiveInt(options.maxReadLines, 2000)
  const maxWriteBytes = positiveInt(options.maxWriteBytes, 2097152)
  const maxResults = positiveInt(options.maxResults, 200)
  const allReadRoots = writeRoot === '' ? readRoots : [...readRoots, writeRoot]

  async function resolveRead(rawPath) {
    const abs = requireAbsolute(rawPath, '读取路径')
    let real
    try {
      real = await fs.realpath(abs)
    } catch (error) {
      throw new Error(`ta-fs: 读取失败：${abs}（${error?.code ?? error?.message ?? 'unknown'}）`)
    }
    if (!allReadRoots.some((root) => isUnder(root, real))) {
      throw new Error(`ta-fs: 路径不在允许的读取范围内：${abs}`)
    }
    return real
  }

  async function resolveWrite(rawPath) {
    const abs = requireAbsolute(rawPath, '写入路径')
    if (writeRoot === '') throw new Error('ta-fs: 没有配置可写工作区')
    const { real, suffix } = await realExistingAncestor(abs)
    const target = path.join(real, ...suffix)
    if (!isUnder(writeRoot, target)) {
      throw new Error(`ta-fs: 只能写入工作区：${abs}`)
    }
    return target
  }

  async function readText(rawPath, { offset = 1, limit = maxReadLines } = {}) {
    const real = await resolveRead(rawPath)
    const stat = await fs.stat(real)
    if (!stat.isFile()) throw new Error(`ta-fs: 不是普通文件：${rawPath}`)
    const bytesToRead = Math.min(stat.size, maxReadBytes)
    const buffer = Buffer.alloc(bytesToRead)
    const handle = await fs.open(real, 'r')
    try {
      if (bytesToRead > 0) await handle.read(buffer, 0, bytesToRead, 0)
    } finally {
      await handle.close()
    }
    if (buffer.subarray(0, Math.min(8192, buffer.length)).includes(0)) {
      throw new Error(`ta-fs: 二进制文件，无法按文本读取：${rawPath}`)
    }
    const truncatedBytes = stat.size > bytesToRead
    const lines = buffer.toString('utf8').split(/\r?\n/)
    const start = clamp(Math.trunc(offset), 1, Math.max(1, lines.length))
    const count = clamp(Math.trunc(limit), 1, maxReadLines)
    const shown = lines.slice(start - 1, start - 1 + count)
    const header = `${real}（共 ${lines.length} 行${truncatedBytes ? `，已按 ${maxReadBytes} 字节上限截断` : ''}）`
    const body = shown.map((line, index) => `${String(start + index).padStart(5, ' ')}\t${line}`).join('\n')
    return {
      path: real,
      text: `${header}\n${body}`,
      totalLines: lines.length,
      fromLine: start,
      toLine: start + shown.length - 1,
      truncatedBytes,
    }
  }

  async function writeText(rawPath, content) {
    if (typeof content !== 'string') throw new Error('ta-fs: content 必须是字符串')
    if (Buffer.byteLength(content, 'utf8') > maxWriteBytes) {
      throw new Error(`ta-fs: 内容超过 ${maxWriteBytes} 字节上限`)
    }
    const target = await resolveWrite(rawPath)
    const dir = path.dirname(target)
    await fs.mkdir(dir, { recursive: true })
    const real = await fs.realpath(target).catch(async () => path.join(await fs.realpath(dir), path.basename(target)))
    if (!isUnder(writeRoot, real)) throw new Error(`ta-fs: 只能写入工作区：${rawPath}`)
    await fs.writeFile(real, content, 'utf8')
    return { path: real, bytes: Buffer.byteLength(content, 'utf8') }
  }

  async function editText(rawPath, oldString, newString, replaceAll = false) {
    if (typeof oldString !== 'string' || oldString === '') throw new Error('ta-fs: old_string 不能为空')
    if (typeof newString !== 'string') throw new Error('ta-fs: new_string 必须是字符串')
    const target = await resolveWrite(rawPath)
    let text
    try {
      text = await fs.readFile(target, 'utf8')
    } catch (error) {
      throw new Error(`ta-fs: 读取失败：${target}（${error?.code ?? error?.message ?? 'unknown'}）`)
    }
    let next
    let count
    if (replaceAll) {
      const parts = text.split(oldString)
      count = parts.length - 1
      if (count === 0) throw new Error('ta-fs: 没找到要替换的内容')
      next = parts.join(newString)
    } else {
      const first = text.indexOf(oldString)
      if (first < 0) throw new Error('ta-fs: 没找到要替换的内容')
      if (text.indexOf(oldString, first + oldString.length) >= 0) {
        throw new Error('ta-fs: old_string 出现多次，请提供更多上下文或设置 replace_all')
      }
      next = text.slice(0, first) + newString + text.slice(first + oldString.length)
      count = 1
    }
    await fs.writeFile(target, next, 'utf8')
    return { path: target, count }
  }

  async function glob(pattern, rawStart) {
    if (typeof pattern !== 'string' || pattern.trim() === '') throw new Error('ta-fs: pattern 不能为空')
    const start = await resolveStart(rawStart)
    const stat = await fs.stat(start)
    if (stat.isFile()) {
      return matchGlob(pattern, path.basename(start)) ? [start] : []
    }
    const results = []
    for await (const file of walkFiles(start)) {
      const rel = path.relative(start, file).split(path.sep).join('/')
      if (!matchGlob(pattern, rel)) continue
      results.push(file)
      if (results.length >= maxResults) break
    }
    results.sort()
    return results
  }

  async function grep(pattern, { path: rawPath, glob: globFilter, ignoreCase = false, maxResults: cap } = {}) {
    let regex
    try {
      regex = new RegExp(pattern, ignoreCase ? 'i' : '')
    } catch {
      throw new Error(`ta-fs: 正则表达式无效：${pattern}`)
    }
    const start = await resolveStart(rawPath)
    const limit = clamp(positiveInt(cap, maxResults), 1, 1000)
    const stat = await fs.stat(start)
    const files = []
    if (stat.isFile()) {
      files.push(start)
    } else {
      for await (const file of walkFiles(start)) {
        if (globFilter === undefined || globFilter === '') {
          files.push(file)
          continue
        }
        const rel = path.relative(start, file).split(path.sep).join('/')
        if (matchGlob(globFilter, path.basename(file)) || matchGlob(globFilter, rel)) files.push(file)
      }
    }
    const results = []
    for (const file of files) {
      if (results.length >= limit) break
      const info = await fs.stat(file).catch(() => undefined)
      if (info === undefined || info.size > 1048576) continue
      const buffer = await fs.readFile(file).catch(() => undefined)
      if (buffer === undefined) continue
      if (buffer.subarray(0, Math.min(8192, buffer.length)).includes(0)) continue
      const lines = buffer.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        if (!regex.test(lines[i])) continue
        results.push(`${file}:${i + 1}:${clipLine(lines[i])}`)
        if (results.length >= limit) break
      }
    }
    return results
  }

  async function resolveStart(rawStart) {
    if (rawStart === undefined || rawStart === null || rawStart === '') {
      if (writeRoot === '') throw new Error('ta-fs: 没有配置可写工作区，需要显式给出搜索目录')
      return writeRoot
    }
    return resolveRead(rawStart)
  }

  return { readRoots, writeRoot, resolveRead, resolveWrite, readText, writeText, editText, glob, grep }
}

/** glob 只支持 *、**、?，按路径段匹配；返回相对路径是否命中。 */
export function matchGlob(pattern, relPath) {
  const patternSegments = String(pattern).replace(/^\.\//, '').split('/').filter((segment) => segment !== '')
  const pathSegments = String(relPath).replace(/^\.\//, '').split('/').filter((segment) => segment !== '')
  return matchSegments(patternSegments, 0, pathSegments, 0)
}

async function* walkFiles(dir, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walkFiles(abs, depth + 1)
    } else if (entry.isFile()) {
      yield abs
    }
  }
}

async function realExistingAncestor(abs) {
  let current = abs
  const suffix = []
  for (;;) {
    try {
      const real = await fs.realpath(current)
      return { real, suffix }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw new Error(`ta-fs: 无法解析路径：${abs}`)
      suffix.unshift(path.basename(current))
      current = parent
    }
  }
}

function resolveRoot(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return ''
  const abs = path.resolve(raw.trim())
  try {
    return realpathSync(abs)
  } catch {
    console.warn(`ta-fs: 目录不存在，已忽略：${abs}`)
    return ''
  }
}

function requireAbsolute(rawPath, name) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new Error(`ta-fs: ${name}不能为空`)
  if (rawPath.includes('\0')) throw new Error('ta-fs: 路径包含非法字符')
  const abs = path.normalize(rawPath.trim())
  if (!path.isAbsolute(abs)) throw new Error(`ta-fs: 请使用绝对路径：${rawPath}`)
  return abs
}

function isUnder(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

function clipLine(line) {
  const chars = Array.from(line)
  return chars.length <= 300 ? line : `${chars.slice(0, 300).join('')}…`
}

function matchSegments(pattern, patternIndex, segments, segmentIndex) {
  if (patternIndex === pattern.length) return segmentIndex === segments.length
  if (pattern[patternIndex] === '**') {
    for (let index = segmentIndex; index <= segments.length; index += 1) {
      if (matchSegments(pattern, patternIndex + 1, segments, index)) return true
    }
    return false
  }
  if (segmentIndex === segments.length) return false
  if (!segmentToRegExp(pattern[patternIndex]).test(segments[segmentIndex])) return false
  return matchSegments(pattern, patternIndex + 1, segments, segmentIndex + 1)
}

function segmentToRegExp(segment) {
  let source = ''
  for (const char of segment) {
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}
