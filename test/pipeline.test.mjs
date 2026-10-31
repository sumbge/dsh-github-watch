/**
 * The two offline steps, end to end: scan a tree, fold it into the inventory.
 *
 * These are the steps that must work on a machine with nothing installed — no
 * git, no gh, no Python. That is why they are the ones covered end to end: if
 * they need something, a fresh install shows an empty page and the operator has
 * no way to tell "nothing was downloaded" from "the scanner is broken".
 *
 * The tree is built in a temp directory and the scan roots are pointed at it, so
 * nothing on the real disk is read and `~/.dsh-github-watch` is never touched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './helpers.mjs'

const box = isolate('gw-pipeline-')

// --- the fake disk -----------------------------------------------------------

const disk = join(box.dir, 'disk')

function write(rel, body = '') {
  const full = join(disk, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body, 'utf8')
}

// A git checkout: `.git` alone qualifies it, and the walk stops descending.
write('plain-repo/.git/config', '[remote "origin"]\n\turl = https://github.com/example/plain-repo.git\n')
write('plain-repo/src/main.js', 'export const x = 1\n')
// A nested repository inside the checkout must NOT become its own row.
write('plain-repo/vendor/inner/.git/config', '')

// A downloaded release binary: no .git, no manifest, only the sidecar record.
write('Programs/tool-x/tool-x.exe', 'MZ')
write('Programs/tool-x/.dsh-source.json', JSON.stringify({
  name: 'tool-x',
  version: '2.0.3',
  summary: 'a ready-made binary',
  repository: 'example/tool-x',
  installed_from: 'https://github.com/example/tool-x/releases/download/v2.0.3/tool-x.zip',
  installed_at: '2026-10-30T22:47:00+08:00',
}))

// A directory with a manifest and source but no git: still a project.
write('pkg-project/package.json', JSON.stringify({ name: 'pkg-project', version: '1.0.0', description: 'a package' }))
write('pkg-project/lib/index.js', 'module.exports = {}\n')

// Empty stub: present but not something anyone obtained.
mkdirSync(join(disk, 'empty-dir'), { recursive: true })

// Noise the scan must ignore.
write('cachemiss/.cache/whatever/package.json', '{}')

process.env.DSH_GITHUB_WATCH_ROOTS = disk
// A profile with no package.json: `declared` falls back to {} instead of throwing.
process.env.DSH_PROFILE_DIR = join(box.dir, 'profile')
mkdirSync(join(box.dir, 'profile'), { recursive: true })

const { main: runInventory } = await import('../lib/inventory.mjs')
const { main: runBuild } = await import('../lib/build.mjs')

// --- tests -------------------------------------------------------------------

test('the inventory step scans a clean data directory without help', async () => {
  const code = await runInventory()
  assert.equal(code, 0)
  const out = join(box.dir, 'local_inventory.json')
  assert.ok(existsSync(out), 'local_inventory.json was not written')

  const data = JSON.parse(readFileSync(out, 'utf8'))
  // Keyed by directory, not by `name`: the scan leaves `name` empty for a bare
  // git checkout and the build step falls back to the directory name, so the name
  // is not this step's answer to give.
  const dirs = data.projects.map((p) => p.path.split(/[\\/]/).pop())
  assert.ok(dirs.includes('plain-repo'), 'the git checkout was missed: ' + dirs.join(','))
  assert.ok(dirs.includes('tool-x'), 'the release binary was missed: ' + dirs.join(','))
  assert.ok(dirs.includes('pkg-project'), 'the manifest project was missed: ' + dirs.join(','))
  // A submodule of a project is not a project.
  assert.ok(!dirs.includes('inner'), 'a nested .git became its own row: ' + dirs.join(','))
  assert.ok(!dirs.includes('empty-dir'), 'an empty directory was counted as a project')

  const tool = data.projects.find((p) => p.path.endsWith('tool-x'))
  assert.equal(tool.version, '2.0.3')
  // The scan writes `remote` for every project; only plugins carry `repo`.
  assert.equal(tool.remote, 'example/tool-x')
  assert.equal(tool.has_git, false)
})

test('the build step folds the scan into the inventory the page reads', async () => {
  const code = await runBuild()
  assert.equal(code, 0)
  const out = join(box.dir, 'inventory.json')
  assert.ok(existsSync(out), 'inventory.json was not written')

  const data = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(
    Object.keys(data),
    ['projects', 'plugins', 'tools', 'discovered', 'scanned_at', 'generated_from'],
    'the top-level shape is what the host half keys off',
  )
  assert.ok(Array.isArray(data.projects))
  assert.ok(data.projects.every((p) => p.exists !== false), 'a vanished row survived the build')
  assert.ok(data.scanned_at, 'scanned_at is what the page shows as "when was this measured"')

  // The release sidecar is what makes the check step able to compare an upstream
  // version for a hand-downloaded binary.
  const tool = data.projects.find((p) => p.name === 'tool-x')
  assert.equal(tool.installed_from.startsWith('https://github.com/example/tool-x/releases/'), true)
})

test('the build step preserves a mute across a rebuild', async () => {
  const out = join(box.dir, 'inventory.json')
  const data = JSON.parse(readFileSync(out, 'utf8'))
  const victim = data.projects.find((p) => p.name === 'pkg-project')
  assert.ok(victim, 'the fixture project is missing')
  victim.muted = true
  writeFileSync(out, JSON.stringify(data, null, 2), 'utf8')

  const code = await runBuild()
  assert.equal(code, 0)
  const after = JSON.parse(readFileSync(out, 'utf8'))
  const still = after.projects.find((p) => p.name === 'pkg-project')
  assert.equal(still.muted, true, 'a rebuild silently un-muted a project the operator parked')
})

test('the steps fail loudly, not silently, without a scan to build from', async () => {
  // A separate data directory, so the scan the tests above produced is absent.
  isolate('gw-pipeline-empty-')
  // A fresh module graph is needed because the paths are resolved at import.
  const mod = await import('../lib/build.mjs?empty=1')
  const code = await mod.main()
  assert.equal(code, 2, 'a missing local_inventory.json must report failure, not exit 0')
})
