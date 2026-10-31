/**
 * Shared helpers for the tests.
 *
 * Every test that imports a step module MUST isolate the data directory first:
 * `lib/check.mjs` and `lib/build.mjs` call `ensureWatchDir()` at module top, and
 * without an override that is the operator's real `~/.dsh-github-watch`. A test
 * run that silently overwrote a real inventory.json would be worse than no test.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** A fresh temp directory, removed by `cleanup()`. */
export function sandbox(prefix = 'gw-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* a leftover temp dir is not a test failure */
      }
    },
  }
}

/**
 * Point the steps at a throwaway directory and return it.
 *
 * Must be called before importing a step module, because those modules resolve
 * the path once at import time.
 *
 * The directory is removed when the process exits: a suite that exits non-zero
 * still has to clean up, and `t.after` does not run for a file that never
 * reached the test body. Leftover `gw-*` directories in %TEMP% were the visible
 * symptom of forgetting that.
 */
export function isolate(prefix = 'gw-test-') {
  const box = sandbox(prefix)
  process.env.DSH_GITHUB_WATCH_DIR = box.dir
  process.once('exit', () => box.cleanup())
  return box
}
