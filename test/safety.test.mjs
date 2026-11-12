/**
 * A delete may only touch a directory this plugin was told to look at.
 *
 * This exists because the first version of the check compared strings: it ran
 * `startsWith(root)` on the raw text it was handed. `C:\Users\me\Desktop\..\..\Windows`
 * starts with `c:\users\me\desktop\` and means something else entirely to the OS,
 * so a malformed entry in inventory.json — or a hand-written POST — reached a
 * directory no scan root contains. The endpoint behind it calls
 * `rm(path, { recursive: true })`, so the difference matters.
 *
 * The cases below are the exact strings that used to pass.
 *
 * The last group guards a second failure of the same shape, a year of drift
 * later: the delete guard kept its own copy of the root rules and read the env
 * var but not `config.json`, so a root the scanner had been told about showed up
 * in the list and then refused to be deleted. The invariant at the bottom is the
 * one that version violated — every root the scanner walks must be reachable by
 * the delete button, and no root may itself be deletable.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isolate } from './helpers.mjs'

const box = isolate('gw-safety-')

const { isSafePath, uninstalledBySlug } = await import('../index.js')
const { roots: scannerRoots } = await import('../lib/config.mjs')

const DESKTOP = join(homedir(), 'Desktop')
const PROFILE_PKG = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-pet')

test('a project under a scan root is allowed', () => {
  assert.equal(isSafePath(join(DESKTOP, 'proj')), true)
  assert.equal(isSafePath(join(DESKTOP, 'AI', 'codex', 'math-modeling-skill')), true)
})

test('a package directly inside a profile node_modules is allowed', () => {
  assert.equal(isSafePath(PROFILE_PKG), true, 'deleting a plugin became impossible')
})

test('dot-dot never gets normalised into an allowed root', () => {
  // Every one of these answered `true` before, and each one resolves outside
  // Desktop. The segment check is what refuses them now; the `resolvePath` call
  // below it cannot change the answer for any input that gets that far, so no
  // test can make that line look load-bearing. Removing the segment check fails
  // this test, which is the only claim being made here.
  const traversals = [
    DESKTOP + '\\..\\..\\Windows\\System32',
    DESKTOP + '\\proj\\..\\..\\..\\..\\.ssh',
    DESKTOP + '\\..\\.dsh\\profiles\\desktop\\node_modules\\dsh-pet',
    join(DESKTOP, '..', '..', 'Windows'),
    DESKTOP + '\\..',
  ]
  for (const p of traversals) {
    assert.equal(isSafePath(p), false, 'traversal accepted: ' + p)
  }
})

test('a single-dot segment is refused too', () => {
  assert.equal(isSafePath(DESKTOP + '\\.\\proj'), false)
})

test('the roots themselves are not projects', () => {
  // Deleting `~/Desktop` would take every project with it. This shape is what a
  // truncated inventory entry leaves behind.
  for (const root of ['Desktop', 'Documents', 'Downloads']) {
    assert.equal(isSafePath(join(homedir(), root)), false, root + ' was deletable')
    assert.equal(isSafePath(join(homedir(), root) + '\\'), false, root + '\\ was deletable')
  }
})

test('paths outside every root are refused', () => {
  assert.equal(isSafePath('C:\\Windows\\System32'), false)
  assert.equal(isSafePath(join(homedir(), '.ssh')), false)
  assert.equal(isSafePath(join(homedir(), '.dsh')), false, 'the whole DSH home was deletable')
  assert.equal(isSafePath(join(homedir(), '.dsh', 'profiles')), false)
  assert.equal(isSafePath(join(homedir(), '.dsh', 'profiles', 'desktop')), false)
  assert.equal(isSafePath(join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')), false)
  assert.equal(isSafePath(join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@local')), false,
    'a scope directory holds every package under it')
})

test('a scoped package is allowed but the scope itself is not', () => {
  assert.equal(isSafePath(join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@local', 'dsh-agent-autoforge')), true)
})

test('junk input is refused rather than throwing', () => {
  for (const p of ['', '   ', 'Desktop\\proj', '\\\\server\\share\\x', 'C:', 'C:\\', null, undefined, 42, {}]) {
    assert.equal(isSafePath(p), false, 'accepted junk: ' + JSON.stringify(p))
  }
})

test('a release binary under Programs is deletable when Programs is scanned', () => {
  // This is the concrete case that exposed the drift: the scanner walks
  // %LOCALAPPDATA%\Programs, so an installed release shows up as a row, and the
  // delete button used to answer "路径不在允许范围内" for it.
  //
  // The directory is conditional — `roots()` only adds Programs when it exists —
  // so the assertion has to be conditional too. A CI runner has no such folder,
  // and an unconditional assertion here failed there while the code was correct.
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const programs = join(local, 'Programs')
  if (!existsSync(programs)) return
  assert.equal(isSafePath(join(programs, 'orca')), true, 'a scanned release cannot be deleted')
  assert.equal(isSafePath(programs), false, 'the Programs root itself is not a project')
})

test('every root the scanner walks is reachable by the delete guard', () => {
  // The invariant, not a list of names: a root added to `roots()` without the
  // guard learning about it is exactly the bug this replaced, and any future
  // root will fail here instead of failing quietly in the dialog.
  const roots = scannerRoots()
  assert.ok(roots.length > 0, 'the scanner reports no roots at all')
  for (const [path] of roots) {
    assert.equal(isSafePath(join(String(path), '__probe__')), true,
      'the scanner walks ' + path + ' but the delete guard refuses it')
    assert.equal(isSafePath(String(path)), false,
      'the root itself is deletable: ' + path)
  }
})

test('the configured watch roots are honoured', () => {
  // A root the operator declared for the scanner has to be deletable too,
  // otherwise the page shows a project and refuses to act on it.
  const extra = join(homedir(), 'Somewhere', 'Code')
  const old = process.env.DSH_GITHUB_WATCH_ROOTS
  process.env.DSH_GITHUB_WATCH_ROOTS = extra
  try {
    assert.equal(isSafePath(join(extra, 'proj')), true)
    assert.equal(isSafePath(extra), false, 'the configured root itself is not a project')
  } finally {
    if (old === undefined) delete process.env.DSH_GITHUB_WATCH_ROOTS
    else process.env.DSH_GITHUB_WATCH_ROOTS = old
  }
})

test('a failed delete is not read back as a completed one', () => {
  // The record is written before the bytes are removed, so a delete that throws
  // leaves an entry behind. github-mcp-server is the case: the .exe was locked
  // by a running MCP child, `rm` failed, and the page went on showing a crossed
  // out "已卸载 · 释放 25 MB" over a directory that was still on disk. The
  // attempt is worth keeping; calling it a deletion is the page lying about the
  // machine, which is the one thing a list of what you have must never do.
  const watched = [
    { slug: 'github/github-mcp-server', name: 'github-mcp-server', status: 'removed', size_freed_mb: 25 },
    { slug: 'owner/locked', name: 'locked', status: 'remove-failed', remove_error: 'EBUSY', size_freed_mb: 0 },
    { slug: 'owner/asked', name: 'asked', status: 'asked' },
    { name: 'NoSlug', status: 'removed' },
    { status: 'removed' },
    null,
  ]
  const map = uninstalledBySlug(watched)
  assert.equal(map.has('github/github-mcp-server'), true, 'a real deletion was forgotten')
  assert.equal(map.has('owner/locked'), false, 'a failed delete is being reported as an uninstall')
  assert.equal(map.has('owner/asked'), false, 'merely asking about a repo is not a delete')
  // Keyed by slug when there is one, by name otherwise — the join in snapshot()
  // looks rows up by `p.slug || p.name`, so both spellings have to land.
  assert.equal(map.get('noslug').name, 'NoSlug')
  assert.equal(map.size, 2, 'an entry with neither slug nor name became a row')
})