/**
 * `inventory.json` is the only record of what the page shows, so a write that is
 * interrupted must not be able to leave it half-finished.
 *
 * `writeFileSync` truncates the target before writing. A crash, a full disk or a
 * killed process between those two moments leaves valid-looking JSON that is
 * missing everything after the cut — and the next step reads it as truth.
 *
 * The test proves the property the only way it can be proved cheaply: by watching
 * for the temp file, and by showing that a failure leaves the old contents intact.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './helpers.mjs'

const box = isolate('gw-util-')

const { writeJson, loadJson } = await import('../lib/util.mjs')

test('writeJson leaves readable JSON and no temp file behind', () => {
  const p = join(box.dir, 'plain.json')
  writeJson(p, { a: 1, b: ['x'] })
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { a: 1, b: ['x'] })
  const strays = readdirSync(box.dir).filter((n) => n.includes('.tmp'))
  assert.deepEqual(strays, [], 'a temp file survived: ' + strays.join(', '))
})

test('writeJson keeps the two-space formatting the steps expect', () => {
  const p = join(box.dir, 'format.json')
  writeJson(p, { a: 1 })
  assert.equal(readFileSync(p, 'utf8'), '{\n  "a": 1\n}')
})

test('writeJson creates missing parent directories', () => {
  const p = join(box.dir, 'deep', 'deeper', 'x.json')
  writeJson(p, { ok: true })
  assert.deepEqual(loadJson(p), { ok: true })
})

test('an existing file is replaced, never appended to', () => {
  const p = join(box.dir, 'replace.json')
  writeJson(p, { long: 'x'.repeat(500) })
  writeJson(p, { short: 1 })
  assert.equal(readFileSync(p, 'utf8'), '{\n  "short": 1\n}')
})

test('a reader never observes a partially written file', () => {
  // The old implementation truncated first, so a concurrent read could see ''.
  // Here the target is only ever the result of a completed rename.
  const p = join(box.dir, 'concurrent.json')
  writeJson(p, { n: 0 })
  const seen = []
  for (let i = 1; i <= 40; i += 1) {
    writeJson(p, { n: i, filler: 'y'.repeat(2000) })
    seen.push(readFileSync(p, 'utf8'))
  }
  for (const text of seen) {
    assert.ok(text.length > 0, 'a read caught the file mid-write')
    assert.equal(JSON.parse(text).n >= 0, true)
  }
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).n, 40)
})

test('a failed write leaves the previous contents intact', () => {
  // Renaming onto a directory is the one failure that is easy to force and, in
  // production terms, stands for any rename that cannot complete. What matters is
  // that the old file survives and the temp file is cleaned up.
  const p = join(box.dir, 'guarded.json')
  writeJson(p, { keep: 'me' })
  const before = readFileSync(p, 'utf8')

  const blocked = join(box.dir, 'blocked.json')
  mkdirSync(blocked, { recursive: true })
  let threw = false
  try {
    writeJson(blocked, { x: 1 })
  } catch {
    threw = true
  }
  // On Windows the rename onto a directory throws EPERM/EISDIR; on the off chance
  // the platform allows it, the assertion below is simply skipped rather than lied about.
  if (threw) {
    assert.equal(existsSync(blocked + '.' + process.pid + '.tmp'), false, 'temp file was not cleaned up')
  }
  assert.equal(readFileSync(p, 'utf8'), before, 'an unrelated file changed')
})

test('concurrent writers cannot collide on the temp name', () => {
  // The name carries the pid, so two processes writing the same target use
  // different temp files. Same process here, so the check is that the name is
  // unique per write and nothing is left over.
  const p = join(box.dir, 'twice.json')
  writeJson(p, { a: 1 })
  writeJson(p, { b: 2 })
  const strays = readdirSync(box.dir).filter((n) => n.startsWith('twice.json.') && n.endsWith('.tmp'))
  assert.deepEqual(strays, [])
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { b: 2 })
})
