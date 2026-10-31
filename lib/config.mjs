/**
 * Shared configuration for the github-watch steps.
 *
 * The three steps (inventory / build / check) all need the same two facts: where
 * the data directory is, and which roots to scan. Hardcoding either makes the
 * tool one-machine-only, so both are resolved here.
 *
 * Resolution order for the data directory, first hit wins:
 *   1. DSH_GITHUB_WATCH_DIR
 *   2. <plugin>/config.json  {"watchDir": "..."}
 *   3. ~/.dsh-github-watch
 *
 * Scan roots come from the same config ({"roots": ["D:\\code"]}) or from
 * DSH_GITHUB_WATCH_ROOTS (semicolon-separated). With neither, the usual
 * Desktop / Documents / Downloads are used.
 */
import { readFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The package root. `lib/` sits one level inside it, the same relationship the
 * old `scripts/` directory had — so config.json still resolves to the same file
 * whether the caller is the host half or a standalone run.
 */
export const PLUGIN_DIR = dirname(HERE)

export function home() {
  return homedir()
}

export function isdir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function isfile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Directory entries, sorted; [] instead of throwing when unreadable. */
export function listdir(p) {
  try {
    return readdirSync(p).sort()
  } catch {
    return []
  }
}

function readConfig() {
  for (const path of [join(PLUGIN_DIR, 'config.json')]) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'))
      if (data && typeof data === 'object' && !Array.isArray(data)) return data
    } catch {
      /* absent or unparseable: fall through to the next source */
    }
  }
  return {}
}

/** Where inventory.json / report.md live. */
export function watchDir() {
  const fromEnv = process.env.DSH_GITHUB_WATCH_DIR
  if (fromEnv) return fromEnv
  const cfg = readConfig().watchDir
  if (typeof cfg === 'string' && cfg) return cfg
  return join(home(), '.dsh-github-watch')
}

/**
 * Create the data directory if it is not there yet, and return it.
 *
 * Every step writes its output into this directory on its last line, and on a
 * clean install the directory does not exist — so without this the run dies
 * after doing all of the work. The host half also calls it before spawning a
 * step; this is the belt to that suspenders, because the steps are runnable on
 * their own (the daily scheduled task does exactly that).
 */
export function ensureWatchDir() {
  const path = watchDir()
  try {
    mkdirSync(path, { recursive: true })
  } catch {
    /* a later write fails with a message about the real problem */
  }
  return path
}

/**
 * (path, maxDepth) pairs to walk.
 *
 * Defaults cover the directories people actually clone into. Depth is bounded
 * because walking the whole tree is what made the first version take minutes.
 * `maxDepth: null` means "no limit" — a conventional project parent is allowed
 * to run deep because the `.git` stop makes depth the wrong thing to bound.
 */
export function roots() {
  const cfg = readConfig()
  let declared = cfg.roots || []
  if (typeof declared === 'string') declared = [declared]
  const pairs = []
  for (const item of declared) {
    if (typeof item === 'string' && item) pairs.push([item, 5])
    else if (item && typeof item === 'object' && item.path) {
      pairs.push([item.path, Number.parseInt(item.depth ?? 5, 10)])
    }
  }
  if (pairs.length) return pairs

  const fromEnv = process.env.DSH_GITHUB_WATCH_ROOTS
  if (fromEnv) {
    return fromEnv
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => [p, 5])
  }

  const h = home()
  const out = [
    [join(h, 'Desktop'), 5],
    [join(h, 'Documents'), 4],
    [join(h, 'Downloads'), 3],
  ]
  // Programs is where a downloaded release binary lands when it is installed
  // rather than cloned. It is shallow and small (a handful of directories), so
  // it is cheap to walk; anything there that is not a program is ignored by the
  // same qualify rules that apply everywhere else.
  const local = process.env.LOCALAPPDATA || join(h, 'AppData', 'Local')
  const programs = join(local, 'Programs')
  if (isdir(programs)) out.push([programs, 2])
  return out
}

/** node_modules of every DSH profile on this machine. */
export function profileNodeModules() {
  const base = join(home(), '.dsh', 'profiles')
  const found = []
  for (const name of listdir(base)) {
    const nm = join(base, name, 'node_modules')
    if (isdir(nm)) found.push(nm)
  }
  return found
}

/**
 * The profile whose package.json records how each plugin was installed and which
 * ones it declares.
 *
 * DSH exports DSH_PROFILE_DIR to every child process, so a profile named
 * differently resolves without editing this file; the literal default is the
 * fallback for a run started outside DSH (a scheduled task, a test).
 */
export function profileDir() {
  return (
    process.env.DSH_PROFILE_DIR ||
    join(home(), '.dsh', 'profiles', process.env.DSH_PROFILE || 'desktop')
  )
}

/**
 * Bare name of the profile (`desktop`), which is what the inventory step writes
 * into each entry's "profile" field. Derived, not spelled out.
 */
export function profileName() {
  const p = profileDir().replace(/[\\/]+$/, '')
  return p.split(/[\\/]/).pop() || 'desktop'
}

/** %APPDATA% / %LOCALAPPDATA% with the documented fallbacks. */
export function appdata() {
  return process.env.APPDATA || join(home(), 'AppData', 'Roaming')
}

export function localappdata() {
  return process.env.LOCALAPPDATA || join(home(), 'AppData', 'Local')
}

export { resolve }
