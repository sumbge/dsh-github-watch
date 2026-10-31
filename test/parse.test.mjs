/**
 * The report parser and the blurb splitter.
 *
 * Both are pure functions over text, and both have a history of silently
 * dropping rows: the kind column was once enumerated as git|npm|snapshot|local,
 * so a pypi or tags row never reached the page, and the summary column was read
 * as a fifth cell that a four-column table does not have. Neither failure threw.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolate } from './helpers.mjs'

// `index.js` resolves its data directory at import time.
const box = isolate('gw-parse-')
void box

const { parseReport, splitBlurb } = await import('../index.js')

const HEAD = [
  '# GitHub 项目更新报告',
  '',
  '生成时间：2026-10-31 18:00　｜　共 **3** 个项目',
  '有更新 **1**　上游有新提交 2　已下架 0　已最新 5　失败 0　无上游 3',
  '',
  '| 项目 | 类型 | 状态 | 说明 | 更新内容 |',
  '|---|---|---|---|---|',
]

test('parseReport reads the generated stamp and the counts', () => {
  const md = [...HEAD, '| bun | npm | ✅ 最新 | 本地 1.4.4 = 上游 1.4.4 |  |', ''].join('\n')
  const r = parseReport(md)
  assert.equal(r.generatedAt, '2026-10-31 18:00')
  assert.deepEqual(r.counts, { updated: 1, current: 5, failed: 0 })
})

test('parseReport keeps every kind, not just the ones it once enumerated', () => {
  // Each of these kinds broke the page at some point by being filtered out.
  const md = [...HEAD,
    '| bun | npm | ✅ 最新 | 本地 1.4.4 = 上游 1.4.4 |  |',
    '| terse-mcp | pypi | 🔴 有更新 | 本地 0.45.0 → 上游 0.49.0 | 新增 --json 输出 |',
    '| dsh-mcp-manager | tags | ✅ 最新 | 本地 0.13.2 = 上游 v0.13.2 ｜ 2026-10-23 |  |',
    '| github-mcp-server | release | ✅ 最新 | 本地 2.0.3 = 上游 v2.0.3 |  |',
    '| math-modeling-skill | git | 🔴 有更新 | 上游 149200a ≠ 本地 abecb64 |  |',
    '| @local/x | link | — 无上游 | 本地包（@local） |  |',
    '| dsh-purge | dir | — 无上游 |  |  |',
    '| bunny | npx cache | ✅ 最新 | 本地 1.0 = 上游 1.0 |  |',
    '',
  ].join('\n')
  const r = parseReport(md)
  const kinds = r.rows.map((x) => x.kind)
  for (const k of ['npm', 'pypi', 'tags', 'release', 'git', 'link', 'dir', 'npx cache']) {
    assert.ok(kinds.includes(k), 'kind ' + k + ' was dropped: ' + kinds.join(','))
  }
})

test('parseReport strips the leading emoji and keeps the words', () => {
  const md = [...HEAD,
    '| a | npm | ⚠ 检查失败 | 网络不通 |  |',
    '| b | npm |  受 Python 版本限制 | 需要 3.14 |  |',
    '',
  ].join('\n')
  const r = parseReport(md)
  assert.deepEqual(r.rows.map((x) => x.status), ['检查失败', '受 Python 版本限制'])
})

test('parseReport lifts the upstream version out of the detail cell', () => {
  // The page reuses this version to build `github:repo#tag` without a second API
  // call, so losing it costs a round trip at the worst possible moment.
  const md = [...HEAD, '| dsh-mcp-manager | tags | 🔴 有更新 | 本地 0.13.0 → 上游 v0.13.2 |  |', ''].join('\n')
  const r = parseReport(md)
  assert.equal(r.rows[0].upstream, 'v0.13.2')
})

test('parseReport reads the trailing summary column when there is one', () => {
  const md = [...HEAD, '| x | npm | 🔴 有更新 | 本地 1 = 上游 2 | 修掉崩溃 |', ''].join('\n')
  const r = parseReport(md)
  assert.equal(r.rows[0].summary, '修掉崩溃')
  assert.equal(r.rows[0].detail, '本地 1 = 上游 2')
})

test('parseReport tolerates a four-column table and an empty report', () => {
  const four = [...HEAD.slice(0, 6), '|---|---|---|---|', '| x | npm | ✅ 最新 | 本地 1 = 上游 1 |', ''].join('\n')
  assert.equal(parseReport(four).rows.length, 1)
  assert.deepEqual(parseReport('').rows, [])
  assert.equal(parseReport('').generatedAt, null)
  assert.deepEqual(parseReport('# nothing here\n').rows, [])
  // The separator row itself must never come back as a project.
  assert.ok(!parseReport(four).rows.some((r) => String(r.project).includes('---')))
})

test('splitBlurb cuts at a sentence, not at a character count', () => {
  // The first sentence has to clear MIN_LEAD (18 chars): a six-word lead reads as
  // a title, not as a summary, so the function deliberately shows everything
  // instead of folding that early.
  const s = '这是一个解释反汇编、汇编、反编译全都支持的说明。还带一个调试器。'
  const { lead, rest } = splitBlurb(s)
  assert.equal(lead, '这是一个解释反汇编、汇编、反编译全都支持的说明。')
  assert.equal(rest, '还带一个调试器。')
})

test('splitBlurb does not cut inside a —— list', () => {
  // Cutting at the dash leaves a dangling "—" and hides what the thing does,
  // which reads as a typo rather than as a fold.
  const s = '分析编译后的代码——反汇编、汇编、反编译，一条命令全做完。'
  const { lead } = splitBlurb(s)
  assert.ok(!lead.endsWith('—'), 'the lead ends on a dangling dash: ' + lead)
})

test('splitBlurb keeps a short string whole and handles nothing', () => {
  assert.deepEqual(splitBlurb('很短'), { lead: '很短', rest: '' })
  assert.deepEqual(splitBlurb(''), { lead: '', rest: '' })
  assert.deepEqual(splitBlurb(null), { lead: '', rest: '' })
  // No boundary anywhere: showing everything beats a two-word lead.
  const long = '一个没有标点符号的很长的句子一直写下去直到超过最小长度限制'
  assert.deepEqual(splitBlurb(long), { lead: long, rest: '' })
})
