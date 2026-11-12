/**
 * What the 检查更新 button actually runs.
 *
 * This exists because of a regression that no existing test could see: adding a
 * cache to `check` was correct, but the button was still spawning it without
 * `--force`. Before the cache worked, that made no difference — every run was a
 * real run because every run missed. Once the cache started hitting, the same
 * button would serve an answer up to six hours old while the report header
 * claimed the current minute.
 *
 * The bug lived in one line that spawns a subprocess, so it was untestable as
 * written. `stepArgs` is that decision lifted out as data: these assertions are
 * about what the child process is asked to do, not about how it is spawned.
 *
 * Data comes from a temp directory, never the operator's real one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolate } from './helpers.mjs'

// The steps resolve the data directory at import time, so the override has to
// exist before the module is loaded.
isolate('gw-scan-')

const { stepArgs } = await import('../index.js')

test('the button forces a re-check, because that is what its label promises', () => {
  // 检查更新 in the UI. A person who presses it is asking what upstream has
  // right now; answering from a cache is not a slower check, it is a different
  // question being answered than the one asked.
  assert.deepEqual(stepArgs('check', { force: true }).slice(1), ['check', '--force'])
})

test('a run nobody is watching may use the cache', () => {
  // A scheduled task, or rescanAfterUpdate after installing something. There is
  // no one staring at a progress bar, and a cached answer is honest there.
  assert.deepEqual(stepArgs('check').slice(1), ['check'])
})

test('the flag is only attached to the step that has a cache', () => {
  // `inventory` and `build` re-walk the disk unconditionally. Passing a flag they
  // ignore would imply they might not have looked, which is the kind of comment
  // a later reader trusts and is wrong about.
  assert.deepEqual(stepArgs('inventory', { force: true }).slice(1), ['inventory'])
  assert.deepEqual(stepArgs('build', { force: true }).slice(1), ['build'])
})

test('the step name is never dropped from the argv', () => {
  // A guard against a future edit that builds the args in the wrong order: the
  // dispatcher reads argv[2], so losing it makes every step print usage and exit 2.
  for (const step of ['inventory', 'build', 'check']) {
    assert.equal(stepArgs(step)[1], step)
  }
})
