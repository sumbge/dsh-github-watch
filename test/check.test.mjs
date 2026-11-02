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

import { probeGit } from '../lib/check.mjs'

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
