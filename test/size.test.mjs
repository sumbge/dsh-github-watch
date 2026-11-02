/**
 * Deleting a project is irreversible, and the size the confirmation dialog shows
 * is how the operator decides whether to go ahead. That number therefore has two
 * jobs that pull against each other: be big enough to be honest about what is
 * about to disappear, and arrive fast enough that the dialog opens at all.
 *
 * The first version lost that argument on the first count. Walking one project
 * with a `node_modules` took 19.9 s, and a 709 MB install never finished — so the
 * number was exact for the cases nobody needed to think about and absent for the
 * one case that mattered.
 *
 * These tests pin the three decisions that replaced it:
 *
 *   - the walk is bounded, and a bounded walk says so instead of passing an
 *     undercount off as the total;
 *   - symlinks are skipped, because a junction into another tree is not space
 *     this delete reclaims;
 *   - the pool actually counts everything when nothing is bounded, so the speed
 *     did not come out of correctness.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './helpers.mjs'

const box = isolate('gw-size-')

const { dirSize, SIZE_MAX_ENTRIES, SIZE_WORKERS } = await import('../index.js')

/** A tree whose every file has the same size, so the expected total is arithmetic. */
function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
}

test('dirSize counts every byte under the directory', async () => {
  const root = join(box.dir, 'plain')
  tree(root, {
    'a.txt': 'x'.repeat(100),
    'b.txt': 'y'.repeat(250),
    'nested/deep/c.txt': 'z'.repeat(650),
  })
  const got = await dirSize(root)
  assert.equal(got.bytes, 1000)
  assert.equal(got.files, 3)
  assert.equal(got.truncated, false)
})

test('dirSize follows subdirectories at any depth', async () => {
  const root = join(box.dir, 'deep')
  const rel = Array.from({ length: 12 }, (_, i) => 'd' + i).join('/')
  tree(root, { [join(rel, 'leaf.txt')]: 'x'.repeat(10) })
  const got = await dirSize(root)
  assert.equal(got.files, 1, 'a leaf twelve levels down was not reached')
  assert.equal(got.bytes, 10)
})

test('dirSize stops at the entry limit and says it truncated', async () => {
  const root = join(box.dir, 'many')
  const layout = {}
  for (let i = 0; i < 40; i += 1) layout[`f${i}.txt`] = 'x'.repeat(10)
  tree(root, layout)

  const got = await dirSize(root, { maxEntries: 10 })
  assert.equal(got.truncated, true, 'the walk hit its budget without admitting it')
  assert.ok(got.files <= 12, 'it kept going past the limit: ' + got.files)
  assert.ok(got.bytes < 400, 'the total looks like the whole directory')
})

test('dirSize stops at the time limit and says it truncated', async () => {
  const root = join(box.dir, 'slow')
  const layout = {}
  for (let i = 0; i < 200; i += 1) layout[`f${i}.txt`] = 'x'.repeat(10)
  tree(root, layout)

  // Zero milliseconds means the budget is already gone before the first read.
  const got = await dirSize(root, { maxMs: -1 })
  assert.equal(got.truncated, true, 'a walk with no budget left claimed to be complete')
  assert.ok(got.elapsedMs >= 0)
})

test('a truncated count never claims to be the whole directory', async () => {
  const root = join(box.dir, 'partial')
  const layout = {}
  for (let i = 0; i < 40; i += 1) layout[`f${i}.txt`] = 'x'.repeat(10)
  tree(root, layout)

  const full = await dirSize(root)
  const cut = await dirSize(root, { maxEntries: 5 })
  assert.equal(full.truncated, false)
  assert.equal(cut.truncated, true)
  assert.ok(cut.bytes < full.bytes, 'the truncated total is not a lower bound')
})

test('dirSize skips symlinks instead of following them', async (t) => {
  const outside = join(box.dir, 'outside')
  tree(outside, { 'huge.bin': 'x'.repeat(5000) })

  const root = join(box.dir, 'withlink')
  tree(root, { 'own.txt': 'y'.repeat(7) })

  try {
    symlinkSync(outside, join(root, 'link'), 'junction')
  } catch (e) {
    t.skip('this machine will not make a junction: ' + e.message)
    return
  }

  const got = await dirSize(root)
  assert.equal(got.bytes, 7, 'a junction pulled an unrelated tree into the total')
  assert.equal(got.files, 1)
})

test('dirSize survives a file that vanishes mid-walk', async () => {
  const root = join(box.dir, 'racing')
  tree(root, { 'keep.txt': 'x'.repeat(20), 'gone.txt': 'y'.repeat(30) })

  const pending = dirSize(root)
  rmSync(join(root, 'gone.txt'), { force: true })
  const got = await pending

  assert.equal(got.truncated, false)
  assert.ok(got.bytes >= 20, 'it lost the file it had already measured')
  assert.ok(got.bytes <= 50)
})

test('a directory that does not exist is zero, not an error', async () => {
  const got = await dirSize(join(box.dir, 'nope'))
  assert.deepEqual(
    { bytes: got.bytes, files: got.files, truncated: got.truncated },
    { bytes: 0, files: 0, truncated: false },
  )
})

test('the production limits are the ones the sizing decision was made with', () => {
  assert.equal(SIZE_MAX_ENTRIES, 20000)
  assert.equal(SIZE_WORKERS, 16)
})

/**
 * On `SIZE_WORKERS`, and on what these tests deliberately do not claim.
 *
 * Replacing the pool with a single worker leaves every assertion above passing,
 * because one worker still counts every byte correctly — it is only slower. That
 * is the honest state of things: concurrency here is a throughput knob, not a
 * correctness property, and a test that pinned it would have to assert on wall
 * clock time, which on a machine that also runs the editor is a coin flip
 * dressed up as evidence.
 *
 * So the count is asserted as a constant above, and the speed is left to the
 * measurement that motivated the change (19.9 s → well under the 2.5 s budget).
 * Writing a timing assertion here would buy a flaky test, not a guarantee.
 */
