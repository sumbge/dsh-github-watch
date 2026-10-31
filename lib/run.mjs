#!/usr/bin/env node
/**
 * Run one scan step, by name.
 *
 * The host half spawns this instead of a Python script, and the daily scheduled
 * task can run it directly:
 *
 *     node lib/run.mjs inventory
 *     node lib/run.mjs build
 *     node lib/run.mjs check [--force] [--no-write]
 *
 * Why a dispatcher rather than three executables: the steps share one data
 * directory and must run in order, so a single entry point is the only place that
 * can guarantee the order is expressed once. It also gives the host one thing to
 * spawn, which keeps the "which interpreter" question out of index.js entirely —
 * `process.execPath` is already the right Node.
 */
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const STEPS = {
  // Scan the disk. Writes local_inventory.json.
  inventory: 'inventory.mjs',
  // Fold the scan into the registry the page reads. Writes inventory.json.
  build: 'build.mjs',
  // Ask every upstream what it has. Writes report.md + state.json.
  check: 'check.mjs',
}

const step = process.argv[2]
if (!step || !STEPS[step]) {
  console.error(
    `用法: node lib/run.mjs <${Object.keys(STEPS).join('|')}> [args...]\n` +
      `  收到: ${step || '(空)'}`,
  )
  process.exit(2)
}

// The step modules run their work at import time and read `process.argv`
// themselves, so arguments after the step name are forwarded untouched — `check`
// depends on seeing `--force` and `--no-write` in exactly that position.
await import(pathToFileURL(join(HERE, STEPS[step])).href)
