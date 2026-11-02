/**
 * The release-notes summariser.
 *
 * It exists because a changelog is longer than the row it has to fit in, and the
 * first version of this page showed a 20-character slice of the first bullet —
 * every entry ended mid-word ("…（如 iO", "…(fast 模式加双"). Then the fix for that
 * reproduced the opposite failure on English notes: a 1359-character release came
 * back at 93% of its size, `## Tests` included, because the prose path read line
 * by line and only knew CJK full stops as sentence ends.
 *
 * Both numeric regressions are asserted below as ranges, not as exact strings:
 * the wording of a real changelog will change, the fact that a summary is much
 * smaller than its source will not.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { summarizeRelease } = await import('../lib/check.mjs')

/** A release note wrapped at ~80 columns, the shape that broke. */
const PROSE = [
  '## Fixed',
  '',
  'v0.2.2 shipped a test that failed on the CI runner. Nothing was wrong with the',
  'plugin; the test was wrong about the machine.',
  '',
  'The assertion checked a path under %LOCALAPPDATA%\\Programs unconditionally. That',
  'folder is optional, so on a runner without it the test asserted the opposite of',
  'what the scanner does.',
  '',
  '## Tests',
  '',
  '101 tests, green on Node 18, 20, 22 and 24 (run 41444591994).',
  '',
  '## Install',
  '',
  '```',
  'dsh plugin add github:sumbge/dsh-github-watch#v0.2.3',
  '```',
].join('\n')

test('a wrapped English note is joined into paragraphs, not read line by line', () => {
  const out = summarizeRelease(PROSE)
  const lines = out.split('\n')
  // Reading line by line turns each hard wrap into its own entry, so the tail of a
  // sentence — "plugin; the test was wrong about the machine", "folder is optional,
  // so on a runner without it…" — shows up as a change that begins mid-clause.
  assert.deepEqual(
    lines.filter((l) => /^(plugin;|folder is optional|what the scanner does)/.test(l)),
    [],
    'a wrapped line survived as its own entry: ' + JSON.stringify(lines),
  )
  // Joined, there are exactly two paragraphs, so exactly two entries.
  assert.equal(lines.length, 2, 'expected two entries, got: ' + JSON.stringify(lines))
  // The first entry carries a whole sentence, not the half that fitted on line one.
  assert.match(lines[0], /failed on the CI runner$/)
})

test('a wrapped English note comes back much smaller than it went in', () => {
  const out = summarizeRelease(PROSE)
  const ratio = out.length / PROSE.length
  assert.ok(ratio < 0.6, `summary is ${Math.round(ratio * 100)}% of the source, expected under 60%`)
  assert.ok(out.length > 0, 'the summary is empty')
})

test('sections that are not changes are dropped', () => {
  const out = summarizeRelease(PROSE)
  assert.doesNotMatch(out, /41444591994/, 'a CI run id from ## Tests reached the summary')
  assert.doesNotMatch(out, /101 tests/, 'the test count from ## Tests reached the summary')
  assert.doesNotMatch(out, /dsh plugin add/, 'the install command reached the summary')
})

test('a heading called "Tests" is recognised, not only "testing"', () => {
  // The old pattern was `test(ing)?\b`; the `\b` sits between `t` and `s`, so
  // "Tests" never matched and its body was summarised as a change.
  const out = summarizeRelease('## Tests\n\nAll good on every version we tried.\n')
  assert.equal(out, '', 'the Tests section leaked: ' + JSON.stringify(out))
})

test('a period inside a version number is not a sentence end', () => {
  const out = summarizeRelease('## Fixed\n\n- v0.2.2 tagged a commit whose package.json still said 0.2.2. Install from v0.2.3 instead.\n')
  assert.match(out, /0\.2\.2 tagged a commit whose package\.json still said 0\.2\.2/)
  assert.doesNotMatch(out, /^v0\.2$/m, 'the version was cut at its first period')
})

test('a period inside a filename is not a sentence end', () => {
  const out = summarizeRelease('## Fixed\n\n- check.mjs no longer assumes the file exists. That was the whole bug.\n')
  assert.match(out, /check\.mjs no longer assumes the file exists/)
  assert.doesNotMatch(out, /^check$/m, 'the filename was cut at its extension')
})

test('a real sentence end does cut the entry', () => {
  const out = summarizeRelease('## Fixed\n\n- The guard skips the assertion when the folder is absent. Verified by pointing LOCALAPPDATA elsewhere.\n')
  assert.match(out, /skips the assertion when the folder is absent/)
  assert.doesNotMatch(out, /Verified by pointing/, 'the second sentence was kept')
})

test('bilingual bullets keep the Chinese side and drop the translation', () => {
  const out = summarizeRelease([
    '### Fixed / 修复',
    '',
    '- 重启后压缩不再静默折叠错消息 | compression no longer silently folds the wrong message after a restart',
    '- 网页下拉列出全部可用压缩提示包 | the dropdown lists every compression preset',
  ].join('\n'))
  assert.match(out, /重启后压缩/)
  assert.doesNotMatch(out, /compression no longer silently/, 'the English translation was kept alongside')
})

test('a bullet keeps its heading so the reader knows what kind of change it is', () => {
  const out = summarizeRelease('## Added\n\n- a second argument\n\n## Fixed\n\n- the first one\n')
  assert.match(out, /Added/, 'the section title was dropped')
  assert.match(out, /Fixed/, 'the section title was dropped')
})

test('there is no character budget any more', () => {
  const long = '这是一条足够长的更新说明，描述了一个完整的功能变化，不应该被截断在任何位置，因为读者需要读完它才知道发生了什么变化。'
  const out = summarizeRelease('## 修复\n\n- ' + long + '\n')
  assert.ok(out.includes('读者需要读完它才知道发生了什么变化'), 'the entry was truncated: ' + JSON.stringify(out))
})

test('an empty or junk body returns nothing rather than throwing', () => {
  for (const body of ['', '   ', '\n\n\n', null, undefined]) {
    assert.equal(summarizeRelease(body), '', 'threw or returned text for: ' + JSON.stringify(body))
  }
})
