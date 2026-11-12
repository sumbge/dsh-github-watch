// Tests for probeGit's branch resolution.
//
// These exist because of a real failure: a repository whose default branch is
// `master` reported `ls-remote 失败: ` — with nothing after the colon — on every
// scan. Two things combined to cause it:
//
//   1. The callers passed `pr.branch || 'main'`, so probeGit never saw "unknown"
//      and never asked the remote what its default branch was. The resolution
//      code was present and unreachable.
//   2. `git ls-remote --heads <url> refs/heads/main` exits **0** when the branch
//      does not exist. It prints nothing and says nothing, so the error message
//      was built from an empty string.
//
// Nothing here touches the network: probeGit takes the runner as its last
// parameter precisely so a fake remote can answer like the real one did.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { probeGit, cacheStillDescribes, makeRow, render, laneForProject, versionKey, cmpVersion } from '../lib/check.mjs'

const SLUG = 'HBAI-Ltd/Toonflow-app'

/**
 * A fake `git` that behaves like the real one for this repo: HEAD is on
 * `master`, and asking for a branch that does not exist is a *successful*
 * command with no output.
 */
function masterRepo(calls) {
  return (args) => {
    calls.push(args.join(' '))
    if (args[0] === 'ls-remote' && args[1] === '--symref') {
      return ['ref: refs/heads/master\tHEAD\nd7366e3\tHEAD', 0, '']
    }
    // Shape: ls-remote --heads <url> refs/heads/<name> — the ref is args[3].
    if (args[0] === 'ls-remote' && args[3] === 'refs/heads/master') {
      return ['d7366e36ba30943cf308121c28011b45bbf922e0\trefs/heads/master', 0, '']
    }
    // The important part: a missing branch is exit 0, empty stdout, empty stderr.
    return ['', 0, '']
  }
}

test('probeGit resolves the default branch when the caller does not know it', () => {
  const calls = []
  const got = probeGit(SLUG, null, [], masterRepo(calls))
  assert.equal(got.ok, true, 'a master-default repo must not fail')
  assert.equal(got.remote_sha, 'd7366e3')
  assert.ok(
    calls.some((c) => c.includes('--symref')),
    'the default branch was never resolved from the remote',
  )
  assert.ok(
    calls.some((c) => c.includes('refs/heads/master')),
    'the resolved branch was not the one queried',
  )
})

test('probeGit does not fall back to main when the caller says nothing', () => {
  // The original bug in one line: `branch || 'main'` upstream made the branch
  // non-null, so this path never ran and main was queried instead of master.
  const calls = []
  const got = probeGit(SLUG, '', [], masterRepo(calls))
  assert.equal(got.ok, true)
  assert.ok(
    !calls.some((c) => /refs\/heads\/main$/.test(c)),
    'queried main, which is the guess this is meant to avoid: ' + calls.join(' / '),
  )
})

test('a stale branch from the registry is re-resolved before failing', () => {
  // registry.json remembers what worked before. If the upstream renames its
  // default branch, a remembered `main` must not become a permanent failure.
  const calls = []
  const got = probeGit(SLUG, 'main', [], masterRepo(calls))
  assert.equal(got.ok, true, 'a remembered but wrong branch should recover')
  assert.ok(calls.some((c) => c.includes('refs/heads/main')), 'did not try the remembered name')
  assert.ok(calls.some((c) => c.includes('refs/heads/master')), 'did not retry the real default')
})

test('a branch named by the caller is used as given', () => {
  const calls = []
  const got = probeGit(SLUG, 'master', [], masterRepo(calls))
  assert.equal(got.ok, true)
  assert.ok(
    !calls.some((c) => c.includes('--symref')),
    'asked the remote for the default even though the branch was known',
  )
})

test('a failure never renders as a colon with nothing after it', () => {
  // The empty message is what made this hard to diagnose. Any failure has to say
  // something a reader can act on.
  const nowhere = () => ['', 0, '']
  const got = probeGit(SLUG, null, [], nowhere)
  assert.equal(got.ok, false)
  assert.ok(got.error.length > 0, 'error is empty')
  assert.ok(
    !/[:：]\s*$/.test(got.error),
    'error ends with a bare colon: ' + JSON.stringify(got.error),
  )
})

test('a real git failure keeps its message', () => {
  // Resolution works, the branch listing is what broke. The reader gets git's own
  // words instead of a guess about branches.
  const broke = (args) => {
    if (args[1] === '--symref') return ['ref: refs/heads/master\tHEAD', 0, '']
    return ['', 128, 'fatal: could not read from remote repository']
  }
  const got = probeGit(SLUG, null, [], broke)
  assert.equal(got.ok, false)
  assert.ok(got.error.includes('could not read from remote repository'), got.error)
})

test('a transport failure is reported as one, not as a branch problem', () => {
  // No network at all: `--symref` cannot answer either. Saying "无法确定默认分支"
  // with no detail would send the reader looking for a branch that was never the
  // problem.
  const offline = () => ['', 128, 'fatal: unable to access: Could not resolve host: github.com']
  const got = probeGit(SLUG, null, [], offline)
  assert.equal(got.ok, false)
  assert.ok(got.error.includes('Could not resolve host'), 'the transport failure was swallowed: ' + got.error)
})

test('git succeeding while saying nothing about HEAD is its own message', () => {
  // The awkward middle case: exit 0, no ref line. Not a network failure and not a
  // wrong branch — the remote simply did not say. It still has to read as a
  // sentence rather than a colon.
  const silent = () => ['', 0, '']
  const got = probeGit(SLUG, null, [], silent)
  assert.equal(got.ok, false)
  assert.ok(got.error.length > 6, got.error)
  assert.ok(!/[:：]\s*$/.test(got.error), got.error)
})

test('a token in git stderr is masked', () => {
  const leaky = (args) => {
    if (args[1] === '--symref') return ['', 0, '']
    return ['', 128, 'fatal: unable to access https://x-access-token:ghp_SECRET123@github.com/x']
  }
  const got = probeGit(SLUG, null, [], leaky)
  assert.equal(got.ok, false)
  assert.ok(!got.error.includes('ghp_SECRET123'), 'token survived into the message: ' + got.error)
})

// ── the cache ────────────────────────────────────────────────────────────────
//
// A real six-hour cache that never once hit. `makeRow` keeps the display line
// `本地 → 上游` in `versions`, and the staleness check compared that string to the
// bare local version: `"0.9.12 → 0.9.12"` is never `"0.9.12"`, so every run
// declared the cache stale and paid the full thirty seconds again. The two
// fields exist separately (`versions` for the row, `local` for the comparison)
// and these tests are what keeps them separate.

test('cache: an unchanged install keeps its cached rows', () => {
  const cached = [makeRow({ name: 'dsh-ego-browser', kind: 'npm', versions: '0.9.12 → 0.9.12', local: '0.9.12' })]
  const projects = [{ name: 'dsh-ego-browser', local_version: '0.9.12' }]
  assert.equal(cacheStillDescribes(cached, projects), true)
})

test('cache: the display line is not the thing compared', () => {
  // The exact shape that broke it: an arrow in `versions`, a bare version in the
  // registry. If someone ever points the comparison back at `versions`, this fails.
  const cached = [makeRow({ name: 'dsh-xdpool', kind: 'tags', versions: '2.6.4 → v2.6.2', local: '2.6.4' })]
  const projects = [{ name: 'dsh-xdpool', local_version: '2.6.4' }]
  assert.equal(cacheStillDescribes(cached, projects), true)
})

test('cache: a new upstream release alone does not invalidate it', () => {
  // The row still says `0.9.12 → 0.9.12` because that is what was cached; upstream
  // releasing 0.9.13 must not force a re-check — that is the whole point.
  const cached = [makeRow({ name: 'x', kind: 'npm', versions: '0.9.12 → 0.9.12', local: '0.9.12' })]
  assert.equal(cacheStillDescribes(cached, [{ name: 'x', local_version: '0.9.12' }]), true)
})

test('cache: an upgraded install invalidates it, with or without the local field', () => {
  const withLocal = [makeRow({ name: 'x', kind: 'npm', versions: '0.45.0 → 0.49.0', local: '0.45.0' })]
  assert.equal(cacheStillDescribes(withLocal, [{ name: 'x', local_version: '0.49.0' }]), false)

  // A row written by an older version has no `local`; the left half of the
  // display line stands in, so one run after upgrading still re-checks.
  const legacy = [{ name: 'x', versions: '0.45.0 → 0.49.0' }]
  assert.equal(cacheStillDescribes(legacy, [{ name: 'x', local_version: '0.49.0' }]), false)
  assert.equal(cacheStillDescribes(legacy, [{ name: 'x', local_version: '0.45.0' }]), true)
})

test('cache: a project appearing or disappearing invalidates it', () => {
  const cached = [makeRow({ name: 'a', kind: 'npm', versions: '1.0.0', local: '1.0.0' })]
  assert.equal(cacheStillDescribes(cached, [{ name: 'a', local_version: '1.0.0' }, { name: 'b', local_version: '2.0.0' }]), false)
  assert.equal(cacheStillDescribes(cached, []), false)
})

test('cache: nothing cached is not a reason to distrust it', () => {
  // No rows at all means there is nothing to serve; `main()` guards on that
  // separately. Returning false here would be a second, redundant guard that
  // reads like the cache is invalid.
  assert.equal(cacheStillDescribes([], [{ name: 'a', local_version: '1.0.0' }]), true)
  assert.equal(cacheStillDescribes(undefined, []), true)
})

test('render: a cached row set is dated when it was fetched, not when it is printed', () => {
  // The page reads the header as "last checked". Printing the current minute
  // over answers fetched six hours ago is the report lying about its own age —
  // and the lie is the whole reason someone presses 检查更新 again.
  const rows = [makeRow({ name: 'x', kind: 'npm', status: '最新', detail: 'ok', versions: '1.0.0 → 1.0.0', local: '1.0.0' })]

  const cached = render(rows, null, { checkedAt: '2026-11-09 10:05' })
  assert.match(cached, /生成时间：2026-11-09 10:05/)
  assert.match(cached, /缓存结果，非本次检查/)

  // A real run carries no `checkedAt` and must not be labelled as a cache hit:
  // the note is a claim about provenance, so it belongs only on the cache path.
  const fresh = render(rows, null)
  assert.doesNotMatch(fresh, /缓存结果/)
  assert.match(fresh, /生成时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
})

/**
 * Every probe lane that can say 有更新 has to publish its notes.
 *
 * This is a source check, not a behavioural one, and deliberately so: reaching the
 * release branch needs a GitHub API response, and the bug being guarded against is
 * a missing line, not wrong arithmetic. A release-sourced binary showed 有更新 with
 * an empty notes column for whole releases because this lane computed got.summary
 * inside probeRelease and never copied it onto the row — while the tags and npm
 * lanes both did.
 *
 * The api/git lanes are excluded on purpose: they compare commits or snapshot
 * timestamps, not releases, so they have no notes to publish. Requiring one there
 * would force a fabricated summary.
 */
test('every release-notes lane that reports an update also publishes its summary', () => {
  const src = readFileSync(new URL('../lib/check.mjs', import.meta.url), 'utf8')
  const lines = src.split('\n')

  // A lane starts at `} else if (how === 'x') {` and runs to the next such line.
  const LANES = [
    { name: 'tags', re: /how === 'tags'/ },
    { name: 'release', re: /how === 'release'/ },
    { name: 'npm/pypi', re: /how === 'npm' \|\| how === 'pypi'/ },
  ]
  const starts = []
  lines.forEach((line, i) => {
    if (/^\s*} else if \(how === /.test(line)) starts.push(i)
  })
  assert.ok(starts.length >= LANES.length, 'could not locate the probe lanes: ' + starts.length)

  for (const lane of LANES) {
    const head = starts.find((i) => lane.re.test(lines[i]))
    assert.ok(head !== undefined, `lane ${lane.name} not found`)
    const next = starts.filter((i) => i > head).sort((a, b) => a - b)[0] ?? lines.length
    const body = lines.slice(head, next)
    assert.ok(
      body.some((l) => /^\s*r\.summary = /.test(l)),
      `lane ${lane.name} can report 有更新 but never sets r.summary — the row will show an empty notes column`,
    )
  }
})

/**
 * Which upstream a row is checked against.
 *
 * Both cases below were live: `DSHgo` (four published releases) and `hyperframes`
 * (a `latest` on npm) were each reported 无上游 for days. The cause was the same
 * shape of mistake twice — the code read a field that only the scanner writes, so
 * every row that arrived from queue.json fell through to an empty probe list. An
 * empty probe list renders as 无上游, which reads as "there is nothing upstream"
 * and is indistinguishable from "we never asked".
 */
test('lane: a row logged in queue.json is still asked about upstream', () => {
  // method: release -> build.mjs copies it onto the row as kind: 'release'
  const rel = laneForProject({ name: 'DSHgo', kind: 'release', slug: 'just-a-FA-for-name/DSHgo' })
  assert.deepEqual(rel.probe, [{ type: 'release' }], 'a release-sourced row must be probed against releases')
  assert.equal(rel.kind, 'release')

  // method: npm -> kind: 'npm', but no `updater` (only the scanner writes that)
  const npm = laneForProject({ name: 'hyperframes', kind: 'npm', slug: 'heygen-com/hyperframes' })
  assert.deepEqual(npm.probe, [{ type: 'npm' }], 'an npm-sourced row must be probed against the registry')
  assert.equal(npm.kind, 'npm')
})

test('lane: every other kind still resolves the way it did', () => {
  const withoutRemote = laneForProject({ name: 'khazix-skills', kind: 'git', slug: '' })
  assert.deepEqual(withoutRemote.probe, [], 'a checkout with no remote has no upstream to ask')

  const withRemote = laneForProject({ name: 'autoforge', kind: 'git', slug: 'sumbge/autoforge' })
  assert.deepEqual(withRemote.probe, [{ type: 'git', branch: null }])

  const snap = laneForProject({ name: 'gh-mcp', kind: 'snapshot', slug: 'github/github-mcp-server' })
  assert.deepEqual(snap.probe, [{ type: 'api', branch: null }])

  const uv = laneForProject({ name: 'terse-mcp', kind: 'uv', updater: 'uv' })
  assert.deepEqual(uv.probe, [{ type: 'pypi' }])
  assert.equal(uv.kind, 'pypi')

  const plain = laneForProject({ name: 'rea', kind: 'dir', slug: '' })
  assert.deepEqual(plain.probe, [], 'a directory with no provenance is honestly 无上游')
})

test('lane: muted is parked, not dropped', () => {
  const m = laneForProject({ name: 'autoforge', kind: 'git', slug: 'sumbge/autoforge', muted: true })
  assert.equal(m.muted, true)
  assert.deepEqual(m.probe, [], 'muting stops the lookup but keeps the row')
})

/**
 * Version comparison.
 *
 * Both spellings below are real: release tags are written `v1.3` and a `npx`
 * install records itself as `hyperframes@0.9.7 (npx)`. Reading the whole string as
 * dotted numbers turned those into [0,3] and [0,9,0] — the first reported a current
 * install as out of date on every run, the second would have called 0.9.7 -> 0.9.37
 * a much bigger jump than it is.
 */
test('versionKey: only the version part of the string is compared', () => {
  assert.deepEqual(versionKey('v1.3'), [1, 3], 'a v prefix is not part of the version')
  assert.deepEqual(versionKey('1.3'), [1, 3])
  assert.equal(cmpVersion(versionKey('1.3'), versionKey('v1.3')), 0, 'v1.3 must not look older than 1.3')

  assert.deepEqual(versionKey('hyperframes@0.9.7 (npx)'), [0, 9, 7], 'a package name and suffix are not part of it')
  assert.equal(cmpVersion(versionKey('0.9.37'), versionKey('hyperframes@0.9.7 (npx)')), 1, 'a real npm update')

  // Not normalised away: a patch release has to remain visible.
  assert.equal(cmpVersion(versionKey('1.3'), versionKey('1.3.0')), -1)

  assert.deepEqual(versionKey(''), [0], 'an empty version still yields a comparable key')
})