/**
 * Small helpers shared by the build and check steps.
 *
 * Only things that would otherwise be copy-pasted three ways: reading/writing the
 * JSON files that link the steps together, and formatting a timestamp the same
 * way the previous implementation did.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { platform } from 'node:process'

/** JSON file contents, or `fallback` when it is missing or unparseable. */
export function loadJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write JSON with the same formatting the previous implementation used. */
export function writeJson(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    /* the write below reports the real problem */
  }
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
}

/** One decimal place, as a number (not a string). */
export function round1(n) {
  return Math.round(Number(n) * 10) / 10
}

/**
 * Local time with an explicit UTC offset, second precision:
 * `2026-10-31T17:16:10+08:00`.
 *
 * Written out rather than `toISOString()` because the offsets matter to the
 * reader: a timestamp without one is ambiguous, and "3 hours ago" computed from
 * a UTC string on a +08:00 machine is wrong by exactly the offset.
 */
export function isoLocal(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** `2026-10-31 17:16` — the form used inside report.md and run.log. */
export function stampShort(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/** Case-folded absolute path, so two spellings of one directory compare equal. */
export function normcase(p) {
  const abs = resolve(p)
  return platform === 'win32' ? abs.toLowerCase() : abs
}

export function pad(str, width) {
  const s = String(str ?? '')
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

export function padStart(str, width) {
  const s = String(str ?? '')
  return s.length >= width ? s : ' '.repeat(width - s.length) + s
}
