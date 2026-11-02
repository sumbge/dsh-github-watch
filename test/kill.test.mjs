/**
 * A timed-out update must actually stop.
 *
 * `child.kill()` reaches the process we spawned and nothing it started. The
 * commands this plugin runs are launchers: `pnpm add` is node running pnpm's
 * entry script, which spawns the installer, which runs lifecycle scripts. Signal
 * the outermost one and the rest keep going — an update that the page reported
 * as failed while it is still writing into node_modules, which is worse than one
 * that never began.
 *
 * The grandchild here is spawned `detached: true` on purpose. Measured on
 * Windows: `taskkill /pid X /F` without `/T` still takes down a *non*-detached
 * grandchild, because the tree is inside the same job object — so a test using
 * an ordinary grandchild passes even when `/T` is removed, and proves nothing.
 * A detached grandchild outlives the plain kill and only dies with `/T`, which
 * is the case these tests need to reproduce.
 *
 * These tests spawn real processes and check that they are gone, because the
 * whole failure mode is "the direct child exited and we called it done". They
 * are Windows-specific by nature (`taskkill /T`), so they skip elsewhere rather
 * than pretending to cover a platform this plugin does not run on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolate } from './helpers.mjs'

const box = isolate('gw-kill-')

const { killTree, runCmd } = await import('../index.js')

const WINDOWS = process.platform === 'win32'

/** Poll until `fn()` is true, or give up. Wall-clock waits here are unavoidable. */
async function until(fn, ms = 5000) {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > end) return false
    await new Promise((r) => setTimeout(r, 50))
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Write a parent script that starts a detached, long-lived grandchild, records
 * its pid, then waits forever. Returns `{ dir, script, marker }`.
 */
function makeDetachedParent(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const marker = join(dir, 'child.pid')
  const script = join(dir, 'parent.mjs')
  writeFileSync(script, `
    import { spawn } from 'node:child_process'
    import { writeFileSync } from 'node:fs'
    const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true })
    kid.unref()
    writeFileSync(${JSON.stringify(marker)}, String(kid.pid))
    setTimeout(() => {}, 60000)
  `)
  return { dir, script, marker }
}

test('killTree stops a child and the detached grandchild it started', { skip: !WINDOWS }, async () => {
  const { dir, script, marker } = makeDetachedParent('gw-tree-')
  const parent = spawn(process.execPath, [script], { stdio: 'ignore', windowsHide: true })

  const gotMarker = await until(() => existsSync(marker))
  assert.ok(gotMarker, 'the test parent never started its grandchild')

  const grandchildPid = Number(readFileSync(marker, 'utf8'))
  assert.ok(grandchildPid > 0)
  assert.equal(isAlive(grandchildPid), true, 'the grandchild was not running to begin with')

  killTree(parent)
  const gone = await until(() => !isAlive(grandchildPid), 8000)

  try { process.kill(grandchildPid, 'SIGKILL') } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true })

  assert.equal(gone, true, 'the grandchild outlived the kill — an update would keep writing')
})

test('a timed-out runCmd also takes the detached grandchild down', { skip: !WINDOWS }, async () => {
  // This is the assertion that separates `killTree` from `child.kill()` on the
  // timeout path: `runCmd` reports a failure either way, so checking only its
  // return code cannot tell whether the tree was actually stopped.
  const { dir, script, marker } = makeDetachedParent('gw-timeout-')

  const started = Date.now()
  const got = await runCmd(process.execPath, [script], 1200)
  const elapsed = Date.now() - started

  assert.ok(elapsed < 15000, 'runCmd did not come back: ' + elapsed + ' ms')
  assert.notEqual(got.code, 0, 'a killed command reported success')

  const grandchildPid = Number(readFileSync(marker, 'utf8'))
  assert.ok(grandchildPid > 0)
  const gone = await until(() => !isAlive(grandchildPid), 8000)

  try { process.kill(grandchildPid, 'SIGKILL') } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true })

  assert.equal(gone, true, 'the timed-out command left a process running behind it')
})

test('runCmd still returns output from a command that finishes', { skip: !WINDOWS }, async () => {
  const got = await runCmd(process.execPath, ['-e', 'console.log("hello")'], 10000)
  assert.equal(got.code, 0)
  assert.match(got.out, /hello/)
})

test('killTree tolerates a child that is already gone', () => {
  // Called twice, or on a process that exited between the timeout firing and the
  // kill landing. Throwing here would turn a timeout into an unhandled rejection.
  const kid = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true })
  assert.doesNotThrow(() => killTree(kid))
  assert.doesNotThrow(() => killTree(null))
  assert.doesNotThrow(() => killTree({}))
})

test('killTree is safe to call on a child it already killed', { skip: !WINDOWS }, async () => {
  // `child.killed` flips as soon as `.kill()` is called, whether or not the
  // process is gone. A second `killTree` — a retry, or a timeout racing a manual
  // cancel — must be a no-op rather than an exception in a timer callback where
  // nothing is listening for it.
  const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  kid.kill()
  assert.equal(kid.killed, true, 'node did not mark the child as killed')
  assert.doesNotThrow(() => killTree(kid))
  await new Promise((r) => setTimeout(r, 200))
  assert.doesNotThrow(() => killTree(kid))
})
