import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPathScope, matchGlob } from '../ta-fs-scope.js'

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ta-fs-'))
let symlinks = false

try {
  const course = path.join(base, 'course')
  const workspace = path.join(base, 'workspace')
  const secret = path.join(base, 'secret')
  await fs.mkdir(course)
  await fs.mkdir(workspace)
  await fs.mkdir(secret)
  await fs.writeFile(path.join(course, 'week1.md'), '# 第 1 周\n环境配置\n')
  await fs.writeFile(path.join(secret, 'keys.txt'), 'SECRET\n')

  const scope = createPathScope({ readRoots: [course], writeRoot: workspace })

  const read = await scope.readText(path.join(course, 'week1.md'))
  assert.match(read.text, /第 1 周/)
  assert.equal(read.totalLines, 3)

  const clipped = await scope.readText(path.join(course, 'week1.md'), { offset: 2, limit: 1 })
  assert.match(clipped.text, /环境配置/)
  assert.doesNotMatch(clipped.text, /第 1 周/)

  await assert.rejects(scope.readText(path.join(secret, 'keys.txt')), /不在允许的读取范围内/)
  await assert.rejects(scope.readText(path.join(course, '..', 'secret', 'keys.txt')), /不在允许的读取范围内/)
  await assert.rejects(scope.readText('relative.md'), /请使用绝对路径/)
  await assert.rejects(scope.writeText(path.join(course, 'x.md'), 'x'), /只能写入工作区/)
  await assert.rejects(scope.writeText(path.join(base, 'outside.md'), 'x'), /只能写入工作区/)

  const nested = path.join(workspace, 'out', 'nested', 'a.md')
  await scope.writeText(nested, 'content\n')
  assert.equal(await fs.readFile(nested, 'utf8'), 'content\n')

  const edited = await scope.editText(nested, 'content', 'updated', false)
  assert.equal(edited.count, 1)
  assert.equal(await fs.readFile(nested, 'utf8'), 'updated\n')

  await fs.writeFile(path.join(workspace, 'b.md'), 'updated updated again\n')
  await assert.rejects(scope.editText(path.join(workspace, 'b.md'), 'updated', 'x'), /出现多次/)

  const globbed = await scope.glob('**/*.md', workspace)
  assert.ok(globbed.some((file) => file.endsWith('a.md')))
  assert.ok(globbed.some((file) => file.endsWith('b.md')))

  const grepped = await scope.grep('updated', { path: workspace, glob: '*.md' })
  assert.equal(grepped.length, 2)

  try {
    await fs.symlink(path.join(secret, 'keys.txt'), path.join(workspace, 'escape.txt'), 'file')
    await fs.symlink(secret, path.join(workspace, 'linkdir'), 'dir')
    symlinks = true
  } catch {
    symlinks = false
  }
  if (symlinks) {
    await assert.rejects(scope.readText(path.join(workspace, 'escape.txt')), /不在允许的读取范围内/)
    await assert.rejects(scope.writeText(path.join(workspace, 'escape.txt'), 'x'), /只能写入工作区/)
    await assert.rejects(scope.writeText(path.join(workspace, 'linkdir', 'x.txt'), 'x'), /只能写入工作区/)
    const walked = await scope.glob('**/*.md', workspace)
    assert.ok(!walked.some((file) => file.includes('linkdir')))
  }

  assert.equal(matchGlob('*.md', 'a.md'), true)
  assert.equal(matchGlob('*.md', 'sub/a.md'), false)
  assert.equal(matchGlob('**/*.md', 'sub/a.md'), true)
  assert.equal(matchGlob('**/*.md', 'a.md'), true)
  assert.equal(matchGlob('docs/**/x?.md', 'docs/xy.md'), true)
  assert.equal(matchGlob('docs/**/x?.md', 'docs/a/b/xy.md'), true)
  assert.equal(matchGlob('docs/**/x?.md', 'docs/a/b/xyz.md'), false)

  console.log(`ta-fs-scope: 全部通过${symlinks ? '（含符号链接逃逸）' : '（系统不支持符号链接，已跳过该项）'}`)
} finally {
  await fs.rm(base, { recursive: true, force: true })
}
