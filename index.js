/**
 * GitHub Watch — host half.
 *
 * The checking is not this plugin's job: `lib/check.mjs` already does it
 * (git ls-remote / GitHub API / npm, one row per repository) and a Windows
 * scheduled task runs it daily at 09:30. This row exists so the result is
 * *visible inside DSH* — it reads the two files that script writes and serves
 * them to the Settings page.
 *
 * The split is deliberate. A plugin that shelled out to git on every page load
 * would take 30 s to render and would hit the network each time Settings opens.
 * Reading two files costs nothing, and "数据时间 HH:MM" is the honest label —
 * it says when the data was measured, not when you happened to look.
 */
import { readFile, stat, readdir, rm, writeFile, rename } from 'node:fs/promises'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export const name = 'github-watch'
// Deliberately NOT a static `inject: ['webServer']`. A plugin that hard-requires
// the GUI webserver cannot load in profiles that never start one, and the route
// is only one half of this feature. It is requested lazily in `apply` instead.
export const inject = []

/**
 * Where the data lives.
 *
 * Configurable because a hardcoded `C:\Users\<someone>\...` makes the plugin
 * useless to anyone else and leaks one machine's layout into a public repo.
 * Resolution order, first hit wins:
 *
 *   1. DSH_GITHUB_WATCH_DIR      — per-shell override, handy for testing
 *   2. config.json next to this file — what the Settings page writes
 *   3. ~/.dsh-github-watch       — the default for a fresh install
 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

// The scan steps ship inside the package and are run from there. They are NOT
// copied into the data directory: an earlier version ran `join(WATCH_DIR, file)`
// and only worked on machines where somebody had hand-copied the step files into
// ~/.dsh-github-watch first. On a clean install that directory is empty, so every
// step answered ENOENT and the page said "暂无报告" forever.
const LIB_DIR = join(PLUGIN_DIR, 'lib')

function resolveWatchDir() {
  const fromEnv = process.env.DSH_GITHUB_WATCH_DIR
  if (fromEnv) return fromEnv
  try {
    const cfg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'config.json'), 'utf8'))
    if (cfg && typeof cfg.watchDir === 'string' && cfg.watchDir) return cfg.watchDir
  } catch { /* no config yet: fall through to the default */ }
  return join(homedir(), '.dsh-github-watch')
}

const WATCH_DIR = resolveWatchDir()

/**
 * Make sure the data directory exists before anything tries to write into it.
 *
 * A fresh install has no ~/.dsh-github-watch, and every script opens its output
 * for writing on the last line — so without this the whole scan dies with
 * FileNotFoundError after doing all the work. Cheap, idempotent, and called on
 * the path that writes rather than at module load (a plugin that creates
 * directories just by being imported is rude).
 */
function ensureDataDir() {
  try {
    mkdirSync(WATCH_DIR, { recursive: true })
  } catch { /* a read-only data dir fails later, with a better message */ }
}

// The profile whose package.json owns the installed plugins. `pnpm add` has to
// run there: adding a package from anywhere else edits the wrong manifest.
//
// Not the literal `~/.dsh/profiles/desktop`: DSH exports DSH_PROFILE_DIR to
// every process it starts, so a machine whose profile is named something else
// (or a second profile) resolves correctly without editing this file. The
// literal path is only the fallback for a call made outside a DSH process.
const PROFILE_DIR = process.env.DSH_PROFILE_DIR
  || join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE || 'desktop')

// pnpm is not on PATH in this deployment: DSH ships its own copy under
// resources/runtime. `process.execPath` is the host executable (DeepSeek
// Harness.exe), so its directory is the install root the runtime hangs off.
// Spawning bare `pnpm` here answers ENOENT, which reads as "update failed" for
// a reason that has nothing to do with the package.
const DSH_ROOT = dirname(process.execPath)
const PNPM_CLI = join(DSH_ROOT, 'resources', 'runtime', 'primary-runtime',
  'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
const NODE_EXE = join(DSH_ROOT, 'resources', 'runtime', 'primary-runtime',
  'dependencies', 'node', 'bin', 'node.exe')

/**
 * `where`-style lookup: returns the first hit, or ''.
 *
 * Kept for the GitHub CLI, which really is an external program. Nothing else here
 * needs it any more: the scan steps run on `process.execPath`, which is by
 * definition the Node that is already running this file.
 */
function whichSync(name) {
  const raw = process.env.PATH || process.env.Path || ''
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
  const hits = []
  for (const dir of raw.split(';')) {
    if (!dir.trim()) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase())
      if (existsSync(candidate)) hits.push(candidate)
    }
  }
  return hits[0] || ''
}

/**
 * Where the GitHub CLI lives.
 *
 * Same resolution shape as the interpreter above, plus the installer's default
 * location: `winget install GitHub.cli` drops gh.exe under Program Files without
 * touching PATH for the host that is already running, so a pure PATH lookup
 * would report "no gh" on a machine that plainly has one.
 */
function resolveGh() {
  const fromEnv = process.env.DSH_GITHUB_WATCH_GH
  if (fromEnv) return fromEnv
  try {
    const cfg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'config.json'), 'utf8'))
    if (cfg && typeof cfg.gh === 'string' && cfg.gh) return cfg.gh
  } catch { /* no config yet */ }
  const onPath = whichSync('gh')
  if (onPath) return onPath
  const known = join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe')
  return existsSync(known) ? known : ''
}

const GH = resolveGh()

/**
 * Account state, read from the CLI rather than from a token held by this plugin.
 *
 * The credential never passes through here. `gh auth status` reports the login,
 * where the credential is stored and which scopes it carries; `gh api rate_limit`
 * reports the quota. That is everything the page needs to show and none of it is
 * a secret — asking for `gh auth token` would put a live credential into an HTTP
 * response for no gain.
 *
 * Cost, measured on this machine: `gh auth status` 1.44 s, `gh api rate_limit`
 * 1.57 s, everything else in the snapshot 16 ms. gh verifies the token against
 * the API before answering, so neither call is local no matter how it is spelled.
 * That shapes the whole design here:
 *
 *   - the two calls run concurrently, not in sequence (2.9 s → ~1.6 s);
 *   - the answer is memoized, because it changes on the scale of minutes;
 *   - and crucially the snapshot does NOT wait for it. The project rows are
 *     local files and have nothing to do with GitHub, so they must not be held
 *     hostage by a network round trip. `ghPeek()` hands back whatever is known
 *     right now and refreshes behind the caller's back; the page fetches the
 *     account card on a second request in parallel.
 */
const GH_TTL_MS = 60000
export const ghCache = { at: 0, value: null, inflight: null, scheduled: false }

/** Start (or join) a refresh. Callers that cannot wait should not call this. */
export function ghRefresh() {
  if (ghCache.inflight) return ghCache.inflight
  ghCache.inflight = ghStatusUncached()
    .then((value) => {
      ghCache.at = Date.now()
      ghCache.value = value
      return value
    })
    .catch(() => ghCache.value)
    .finally(() => { ghCache.inflight = null })
  return ghCache.inflight
}

/**
 * Last known account state, without waiting for a fresh one.
 *
 * Returns null when nothing has been read yet — an empty object would make the
 * page claim "gh not installed", which is a different statement from "not read
 * yet" and would be wrong for the first second after a restart.
 */
export function ghPeek() {
  if (!ghCache.value || Date.now() - ghCache.at >= GH_TTL_MS) {
    // Fire and forget, and deferred on purpose: creating the two processes costs
    // ~80 ms on Windows before either one has said a word, and paying that inside
    // the response that merely mentioned the account would defeat the point.
    // `ghRefresh()` is idempotent, so a peek that runs before the timer fires
    // joins the same read instead of starting a second one.
    if (!ghCache.scheduled) {
      ghCache.scheduled = true
      setImmediate(() => {
        ghCache.scheduled = false
        ghRefresh()
      })
    }
  }
  return ghCache.value
}

export async function ghStatus(options = {}) {
  const fresh = options.fresh === true
  if (!fresh && ghCache.value && Date.now() - ghCache.at < GH_TTL_MS) {
    return ghCache.value
  }
  return ghRefresh()
}

/** Drop the memoized answer, e.g. right after a login completes. */
export function forgetGhStatus() {
  ghCache.at = 0
  ghCache.value = null
}

async function ghStatusUncached() {
  if (!GH) {
    return { available: false, path: '', reason: '没有找到 GitHub CLI（gh），先装 gh 再回来' }
  }
  // Both spawns start together. Sequentially they cost 1.44 + 1.57 s because gh
  // talks to the API inside each one; in parallel the pair costs the slower of
  // the two. `rate_limit` is issued unconditionally even though it is only shown
  // once an account is known: waiting to learn whether one exists, and only then
  // asking for the quota, is exactly the serialization that made this slow.
  const authP = runCmd(GH, ['auth', 'status', '--json', 'hosts'], 20000)
  const rateP = runCmd(GH, ['api', 'rate_limit'], 20000)
  const res = await authP
  if (res.code !== 0) {
    // Logged out is a normal state, not an error: gh exits non-zero and says so
    // on stderr. Only a parse failure below is worth calling broken.
    //
    // The fallback text is not decoration. A Windows build of gh exits 1 with
    // *nothing* on either stream when no account is configured — verified on
    // windows-latest — and an empty `error` left the page unable to say anything
    // at all: not who is logged in, not why nobody is.
    return {
      available: true,
      path: GH,
      loggedIn: false,
      accounts: [],
      active: null,
      rate: null,
      error: (res.err || res.out || '').trim().slice(0, 300)
        || 'gh 已安装，但没有已登录的账号：在终端里跑 gh auth login',
    }
  }
  let hosts = {}
  try {
    hosts = JSON.parse(res.out).hosts || {}
  } catch (err) {
    return {
      available: true,
      path: GH,
      loggedIn: false,
      accounts: [],
      active: null,
      rate: null,
      error: 'gh auth status 返回的不是 JSON：' + String(err?.message ?? err),
    }
  }
  const accounts = []
  for (const [host, list] of Object.entries(hosts)) {
    for (const a of list || []) {
      accounts.push({
        host: a.host || host,
        login: a.login || '',
        active: Boolean(a.active),
        // gh reports a TLS timeout as state:"timeout" rather than hiding the
        // account, so the page can say "登录还在，只是这次没验上".
        state: a.state || '',
        tokenSource: a.tokenSource || '',
        scopes: a.scopes || '',
        gitProtocol: a.gitProtocol || '',
        error: a.error || '',
      })
    }
  }
  const active = accounts.find((a) => a.active) || accounts[0] || null
  // The quota call was already in flight while the account was being read, so
  // awaiting it here costs whatever is left of its ~1.6 s at most — often none.
  // A failure must not make the account look absent: the account line stands on
  // its own and the badge simply goes missing.
  let rate = null
  if (active) {
    const rl = await rateP
    if (rl.code === 0) {
      try {
        const d = JSON.parse(rl.out)
        const core = (d && d.resources && d.resources.core) || d.rate || null
        if (core && core.limit) {
          rate = {
            remaining: core.remaining,
            limit: core.limit,
            resetAt: core.reset ? new Date(core.reset * 1000).toISOString() : null,
          }
        }
      } catch { /* leave null: the account line stands without a quota */ }
    }
  } else {
    // Nothing to read it against. Let it settle so a rejected promise does not
    // surface as an unhandled rejection when gh is installed but logged out.
    rateP.catch(() => {})
  }
  return { available: true, path: GH, loggedIn: Boolean(active), active, accounts, rate, error: '' }
}

/**
 * Device-code login, driven from the page.
 *
 * `gh auth login --web` prints a one-time code and the device URL, then blocks
 * polling GitHub until the browser side accepts. We capture the two strings, hand
 * them to the page, and leave the process running — killing it cancels the
 * pending authorization, so the only reason to kill is a newer attempt.
 */
const ghLogin = {
  running: false,
  code: '',
  url: '',
  startedAt: null,
  finishedAt: null,
  ok: null,
  error: '',
  child: null,
  log: '',
}

const GH_CODE_RE = /one-time code\s*[:(]?\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i
const GH_URL_RE = /(https:\/\/github\.com\/login\/device)/i

function startGhLogin() {
  return new Promise((resolve) => {
    if (!GH) {
      resolve({ ok: false, error: '没有找到 GitHub CLI（gh），先装 gh 再回来' })
      return
    }
    if (ghLogin.running) {
      resolve({ ok: true, running: true, code: ghLogin.code, url: ghLogin.url })
      return
    }
    Object.assign(ghLogin, {
      running: true,
      code: '',
      url: '',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: null,
      error: '',
      log: '',
    })

    let child
    try {
      child = spawn(GH, ['auth', 'login', '--hostname', 'github.com',
        '--git-protocol', 'https', '--web'], {
        windowsHide: true,
        // No TTY and no stdin: the flow is entirely stdout/stderr plus the
        // browser, which is what makes it drivable from a web page at all.
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      Object.assign(ghLogin, { running: false, ok: false, error: String(err?.message ?? err) })
      resolve({ ok: false, error: ghLogin.error })
      return
    }
    ghLogin.child = child

    const grab = (b) => {
      const s = b.toString('utf8')
      ghLogin.log = (ghLogin.log + s).slice(-4000)
      const m = GH_CODE_RE.exec(s)
      if (m && !ghLogin.code) ghLogin.code = m[1].toUpperCase()
      const u = GH_URL_RE.exec(s)
      // gh may not repeat the URL, so default to the well-known device page.
      if (u && !ghLogin.url) ghLogin.url = u[1]
      else if (ghLogin.code && !ghLogin.url) ghLogin.url = 'https://github.com/login/device'
    }
    child.stdout?.on('data', grab)
    child.stderr?.on('data', grab)

    // Declared before the handlers below so an early emit cannot hit the
    // temporal dead zone; `let` + null keeps clearTimeout() safe either way.
    let timer = null
    let settled = false
    const reply = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ ok: true, running: true, code: ghLogin.code, url: ghLogin.url })
    }

    child.on('error', (err) => {
      ghLogin.running = false
      ghLogin.ok = false
      ghLogin.finishedAt = new Date().toISOString()
      ghLogin.error = String(err?.message ?? err)
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: ghLogin.error }) }
    })

    child.on('close', (code) => {
      ghLogin.running = false
      ghLogin.child = null
      ghLogin.finishedAt = new Date().toISOString()
      ghLogin.ok = code === 0
      // A cancel already wrote its own reason. gh answers being killed with the
      // same "One-time code ..." banner it prints on start, which as an error
      // line reads like the login failed rather than like the operator stopped
      // it — so the deliberate reason wins.
      if (code !== 0 && ghLogin.error !== '已取消') {
        ghLogin.error = (ghLogin.log || '').trim().slice(-300) || ('gh 退出码 ' + code)
      }
      // The answer changed: whoever polls next must not read the cached "logged
      // out" for another 30 s after a successful authorization.
      forgetGhStatus()
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: code === 0, code: ghLogin.code, url: ghLogin.url, error: ghLogin.error }) }
    })

    // The code is printed within a second in practice. Reply as soon as it shows
    // up instead of making the page wait for the whole authorization round trip,
    // and give up after 8 s so a silent gh cannot hang the request.
    timer = setTimeout(reply, 8000)
    const poll = setInterval(() => {
      if (ghLogin.code) { clearInterval(poll); reply() }
    }, 100)
    child.on('close', () => clearInterval(poll))
  })
}

/** Cancel a login that is still waiting for the browser, e.g. a mis-click. */
function cancelGhLogin() {
  if (!ghLogin.running || !ghLogin.child) return { ok: true, running: false }
  try { ghLogin.child.kill() } catch { /* already gone */ }
  ghLogin.running = false
  ghLogin.child = null
  ghLogin.finishedAt = new Date().toISOString()
  ghLogin.ok = false
  ghLogin.error = '已取消'
  return { ok: true, running: false }
}

/**
 * The scan pipeline, in order. Each step reads the previous step's file, so the
 * order is not cosmetic: `inventory` writes local_inventory.json, `build` reads it
 * plus the curated overrides and writes inventory.json, `check` reads
 * inventory.json and writes report.md.
 *
 * A full run walks the disk, so it takes ~12 s. The HTTP handler therefore does
 * not wait for it — see startScan/scanState below.
 *
 * `weight` is measured, not guessed: on this machine the three steps take about
 * 2 s, 1 s and 9 s. A progress bar that advanced one third per step would sit at
 * 100 % for 9 of the 12 seconds, which reads as a hang. These fractions make the
 * bar track elapsed work instead of counting steps.
 */
const SCAN_STEPS = [
  { step: 'inventory', weight: 0.22 },
  { step: 'build', weight: 0.10 },
  { step: 'check', weight: 0.68 },
]

let scanState = {
  running: false,
  startedAt: 0,
  finishedAt: 0,
  step: '',
  stepIndex: 0,
  progress: 0,
  error: '',
  output: [],
}

/**
 * Run one scan step, resolving with its exit code and last lines of output.
 *
 * The step code comes from the package and the working directory is the data
 * directory: the package half is read-only and the data directory is where every
 * output belongs, so nothing has to be copied out of the package at install time.
 *
 * `process.execPath` is the running Node, not a guess. The previous version had to
 * resolve a Python interpreter — with a Store-alias fallback, a config override and
 * the interpreter DSH happens to bundle — because there was no way to know which
 * one a machine would have. There is only one Node here, and it is this one.
 */
function runStep(step) {
  return new Promise((resolve) => {
    ensureDataDir()
    const child = spawn(process.execPath, [join(LIB_DIR, 'run.mjs'), step], {
      cwd: WATCH_DIR,
      windowsHide: true,
      env: { ...process.env },
    })
    const tail = []
    let stderr = ''
    const keep = (s) => {
      for (const line of String(s).split('\n')) {
        const t = line.trim()
        if (t) tail.push(t)
      }
      while (tail.length > 12) tail.shift()
    }
    child.stdout?.on('data', (b) => keep(b.toString('utf8')))
    child.stderr?.on('data', (b) => { stderr += b.toString('utf8') })
    // A hung step must not wedge the state forever: kill it after 5 minutes.
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
    }, 300000)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, tail, error: String(err?.message ?? err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // `check` returns 1 when any project failed to check. That is a finding, not
      // a crash of the pipeline, so it is recorded and the run continues.
      resolve({ code, tail, error: stderr.trim().slice(-400) })
    })
  })
}

/** Kick the pipeline off in the background. Returns immediately. */
function startScan() {
  if (scanState.running) return { started: false, reason: 'already running' }

  scanState = {
    running: true, startedAt: Date.now(), finishedAt: 0,
    step: SCAN_STEPS[0].step, stepIndex: 0, progress: 0, error: '', output: [],
  }

  ;(async () => {
    let done = 0
    for (let i = 0; i < SCAN_STEPS.length; i += 1) {
      const { step, weight } = SCAN_STEPS[i]
      scanState.step = step
      scanState.stepIndex = i
      scanState.progress = done
      const res = await runStep(step)
      scanState.output.push({ step, code: res.code, tail: res.tail })
      // `inventory` and `build` must succeed; `check`'s 1 is an acceptable outcome
      // (some project failed, which the report shows).
      const fatal = i < 2 && res.code !== 0
      if (fatal) {
        scanState.error = res.error || `${step} 退出码 ${res.code}`
        break
      }
      done += weight
      scanState.progress = done
    }
    scanState.progress = 1
    scanState.running = false
    scanState.finishedAt = Date.now()
    scanState.step = ''
    // scan_progress.json is deliberately left on disk. `check` rewrites it from
    // scratch — emit(0, "") on entry — so it never accumulates, and after a run
    // that died halfway it is the record of how far the check got. `at` in the
    // file makes a stale copy distinguishable from a live one.
  })()

  return { started: true }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Parse the markdown table the check step writes. Columns: 项目 | 类型 | 状态 | 说明.
 * The prose above the table is for a human reading the file; the table is the
 * part worth parsing.
 */
export function parseReport(md) {
  if (!md) return { generatedAt: null, counts: null, rows: [] }

  const generatedAt = (md.match(/生成时间：([^｜\n]+)/) || [])[1]?.trim() || null

  const counts = {}
  const m = md.match(/有更新\s*\*\*(\d+)\*\*.*?已最新\s*(\d+).*?失败\s*(\d+)/)
  if (m) {
    counts.updated = Number(m[1])
    counts.current = Number(m[2])
    counts.failed = Number(m[3])
  }

  const rows = []
  for (const raw of md.split(/\r?\n/)) {
    // The kind column is whatever the check step decided the upstream is. It used to
    // list only git|npm|snapshot|local, so a row whose kind was pypi or npx was
    // silently skipped and its status never reached the page — which is why
    // Tools showed no update even after the checker had found one. Match the
    // column loosely instead of enumerating values that keep growing.
    const cells = raw.match(/^\|\s*(.+?)\s*\|\s*([\w -]+?)\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/)
      || raw.match(/^\|\s*(.+?)\s*\|\s*([\w -]+?)\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|$/)
    if (!cells) continue
    const [, project, kind, statusRaw, detail] = cells
    // The status cell carries a leading emoji; strip it, keep the words.
    const status = statusRaw.replace(/^[^\p{L}\p{N}]+/u, '').trim()
    if (!status) continue
    // The detail column carries the upstream version ("本地 0.13.0 → 上游
    // v0.13.2"). Pulling it out here is what lets an update reuse the version the
    // checker already paid an API call for, instead of asking again at exactly
    // the moment the anonymous quota may be empty.
    let upstream = ''
    const um = /上游\s*(v?[\d][\w.\-+]*)/.exec(detail || '')
    if (um) upstream = um[1].trim()
    const summary = String(cells[5] || '').trim()
    rows.push({ project, kind, status, detail, upstream, summary })
  }
  return { generatedAt, counts, rows }
}

/**
 * The checker's rows, keyed by name.
 *
 * doUpdate needs the upstream version for a `github:` package, and the report
 * already holds it. Reading it back is cheaper and more reliable than asking
 * GitHub again — especially when the anonymous quota is what blocked the first
 * attempt.
 */
async function readInventoryRows() {
  const md = await readText(join(WATCH_DIR, 'report.md'))
  const parsed = parseReport(md)
  const map = new Map()
  for (const r of parsed.rows || []) map.set(r.project, r)
  return map
}

/** Last line of run.log: when the check step last ran and what it found. */
async function readLastRun() {
  const log = await readText(join(WATCH_DIR, 'run.log'))
  if (!log) return null
  const lines = log.split(/\r?\n/).filter((l) => l.trim())
  const m = (lines[lines.length - 1] || '')
    .match(/^\[([\d-]+ [\d:]+)\]\s*(\d+) 个项目，有更新 (\d+)，耗时 ([\d.]+)s/)
  if (!m) return null
  return { at: m[1], projects: Number(m[2]), updated: Number(m[3]), seconds: Number(m[4]) }
}

/** Project blurbs, keyed by the same names the report uses. */
async function readDescriptions() {
  const raw = await readText(join(WATCH_DIR, 'descriptions.json'))
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    const out = {}
    for (const [name, v] of Object.entries(parsed)) {
      // Accept both {"name": {"description": "..."}} and {"name": "..."} so an
      // older or hand-edited file still reads.
      out[name] = typeof v === 'string' ? v : (v && v.description) || ''
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Split a blurb into the sentence to show and the rest to fold away.
 *
 * Not a character count: cutting at 60 chars splits "反汇编、汇编、反编译" in the
 * middle of a list and the folded line reads as a typo. Cut at a real sentence
 * boundary instead — 。！？ finish a sentence, and the padded full-width
 * punctuation people actually type (．；) counts too. The "—" that separates
 * summary from local state is also a boundary: the two halves answer different
 * questions, so the fold there is meaningful rather than arbitrary.
 *
 * A first sentence longer than `softMax` is still shown whole. Truncating it
 * with an ellipsis would be worse than one long line: the point of the fold is
 * to hide detail, not to mangle the sentence that carries the meaning.
 */
export function splitBlurb(text) {
  const s = String(text || '').trim()
  if (!s) return { lead: '', rest: '' }

  const MIN_LEAD = 18        // shorter than this reads as a title, not a summary
  // 。！？； end a sentence. A lone dash does NOT: in "分析编译后的代码——反汇编、
  // 汇编、反编译" the dash opens an appositive list, so cutting there leaves a
  // dangling "—" and hides what the framework actually does. The " — " the
  // compiler inserts between summary and local state is a real boundary, but it
  // is matched separately below, by the spaced form only.
  const boundary = /[。！？；]/

  const cuts = []
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '—' && s[i + 1] === '—') continue      // part of ——, skip both
    if (boundary.test(s[i])) cuts.push(i + 1)
  }
  // The compiler's " — " separator is a boundary only when it is spaced on both
  // sides; that distinguishes "summary — local state" from an inline dash.
  const sep = s.indexOf(' — ')
  if (sep > 0) cuts.push(sep)
  cuts.sort((a, b) => a - b)
  if (cuts.length === 0) return { lead: s, rest: '' }

  let cut = cuts.find((c) => c >= MIN_LEAD)
  if (cut === undefined) {
    // No boundary is far enough out: either the whole string is short (show it
    // all) or the tail after the last boundary is the only long part. Prefer
    // showing everything over showing a two-word lead.
    cut = cuts[cuts.length - 1]
    if (s.length - cut < MIN_LEAD) return { lead: s, rest: '' }
  }
  if (cut >= s.length) return { lead: s, rest: '' }

  const lead = s.slice(0, cut).trim()
  // Drop a leading dash on the remainder: "— ★537｜..." reads as an aside, not
  // as a new sentence, so the dash is punctuation of the split, not content.
  const rest = s.slice(cut).replace(/^[\s—]+/, '').trim()
  return { lead, rest }
}

/**
 * The report queue other sessions append to (see ~/.agents/AGENTS.md).
 *
 * This is the half a scanner cannot produce: a disk walk knows a directory
 * exists, not who fetched it or why. Anything here is "reported but not yet
 * confirmed", so it renders in its own section and never silently joins the
 * curated list — the operator decides that by adding it to inventory.json.
 */
async function readQueue() {
  const raw = await readText(join(WATCH_DIR, 'queue.json'))
  if (!raw) return []
  try {
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (!Array.isArray(data)) return []
    return data.filter((e) => e && (e.slug || e.name)).map((e) => ({
      name: e.name || String(e.slug || '').split('/').pop() || '(未命名)',
      slug: e.slug || '',
      path: e.path || '',
      method: e.method || '',
      version: e.version || '',
      at: e.at || '',
      note: e.note || '',
      // `want` is the operator's own words for the problem, `note` is why this
      // repo answers it. Both are kept because they answer different questions
      // and only the pair makes the row readable months later.
      want: e.want || '',
    }))
  } catch {
    return []
  }
}

/** The curated registry: which projects and plugins this page shows. */
async function readInventory() {
  const raw = await readText(join(WATCH_DIR, 'inventory.json'))
  if (!raw) return { projects: [], plugins: [], tools: [], discovered: [], scannedAt: null }
  try {
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return {
      projects: Array.isArray(data.projects) ? data.projects : [],
      plugins: Array.isArray(data.plugins) ? data.plugins : [],
      tools: Array.isArray(data.tools) ? data.tools : [],
      discovered: Array.isArray(data.discovered) ? data.discovered : [],
      scannedAt: data.scanned_at || null,
    }
  } catch {
    return { projects: [], plugins: [], tools: [], discovered: [], scannedAt: null }
  }
}

/**
 * Projects the operator looked at but has not (or will not) keep.
 *
 * `asked`     — seen and judged; the `why` is what makes a later download meaningful
 * `downloaded`— promoted into queue.json
 * `dropped`   — decided against; kept so the same thing is not recommended twice
 * `removed`   — was installed, then uninstalled; this is the only evidence that a
 *               missing directory was a decision rather than a broken check
 */
async function readWatched() {
  const raw = await readText(join(WATCH_DIR, 'watched.json'))
  if (!raw) return []
  try {
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (!Array.isArray(data)) return []
    return data.filter((w) => w && (w.slug || w.name))
  } catch {
    return []
  }
}

/**
 * What would be lost if this project were deleted.
 *
 * Deliberately separate from the delete itself: the operator asked for a
 * report-then-confirm flow, and that only works if the numbers come from the
 * disk at confirm time rather than from a cached inventory.json that may be a
 * day stale. Three kinds of bytes, and they are not interchangeable:
 *
 *   reinstallable — the checkout and its deps; `git clone` / `npm i` gets it back
 *   custom        — deps flagged `local: true`; edited in place, no upstream to refetch
 *   work          — `work` output; analysis the operator produced, unrecoverable
 */
async function previewDelete(name) {
  const inv = await readInventory()
  const all = [...inv.projects, ...inv.plugins, ...(inv.tools || [])]
  const target = all.find((p) => p.name === name)
  if (!target) return { ok: false, error: `没有名为 ${name} 的项目` }

  const path = target.path || target.install_path || ''
  // Refuse anything that is not an absolute path inside an allowed root: a typo
  // in inventory.json must not turn into `Remove-Item C:\`.
  if (!isSafePath(path)) {
    return { ok: false, error: `路径不在允许范围内，拒绝操作：${path || '(空)'}` }
  }

  const rows = []
  let reinstallable = 0
  let custom = 0
  let work = 0

  const own = await dirSize(path)
  let totalBytes = own.bytes
  reinstallable += own.mb
  rows.push({ label: '项目本体', mb: own.mb, kind: 'reinstallable', path })

  for (const d of target.deps || []) {
    const s = await dirSize(d.path)
    totalBytes += s.bytes
    if (d.local) custom += s.mb
    else reinstallable += s.mb
    rows.push({ label: d.name, mb: s.mb,
                kind: d.local ? 'custom' : 'reinstallable',
                why: d.why || '', path: d.path })
  }

  if (target.work) {
    const s = await dirSize(target.work.path)
    totalBytes += s.bytes
    work += s.mb
    rows.push({ label: '作业产出', mb: s.mb, kind: 'work',
                why: target.work.why || '', path: target.work.path })
  }

  return {
    ok: true,
    name,
    slug: target.slug || '',
    kind: target.kind || '',
    rows,
    totalMb: Math.round((reinstallable + custom + work) * 10) / 10,
    totalBytes,
    reinstallableMb: Math.round(reinstallable * 10) / 10,
    customMb: Math.round(custom * 10) / 10,
    workMb: Math.round(work * 10) / 10,
    // Say the risk in words, so the confirm step is a decision and not arithmetic.
    warning: work > 0
      ? '其中作业产出是分析结果，删了无法恢复'
      : custom > 0
        ? '其中有本机改过的依赖，上游已无对应版本'
        : '全部可以重新下载',
  }
}

/**
 * Roots a delete is allowed to touch.
 *
 * Built from the real home directory rather than a literal name, so the guard
 * works on any machine and carries no one's username into a public repo. The
 * check exists to stop a malformed `path` in inventory.json from becoming
 * `Remove-Item C:\`, so it errs toward refusing: an unrecognised layout means
 * the operator must say where their projects are.
 */
function allowedRoots() {
  const home = homedir().toLowerCase().replace(/\//g, '\\')
  const roots = ['desktop', 'documents', 'downloads'].map((d) => `${home}\\${d}\\`)
  // Whatever extra roots the operator declared for the scanner.
  for (const extra of String(process.env.DSH_GITHUB_WATCH_ROOTS || '').split(';')) {
    const e = extra.trim().toLowerCase().replace(/\//g, '\\')
    if (e) roots.push(e.endsWith('\\') ? e : e + '\\')
  }
  return roots
}

/**
 * A plugin lives under `~/.dsh/profiles/<name>/node_modules/<package>`, which is
 * none of the user-project roots — so before this, deleting a plugin was
 * impossible no matter what.
 *
 * The pattern is deliberately narrow. Allowing `~/.dsh/` wholesale would let a
 * malformed inventory entry remove a profile, the session DB, or DSH itself.
 * A plugin delete may only target a package directory directly inside some
 * profile's node_modules, which is the one shape npm produces and the one this
 * page offers a delete button for.
 */
function isProfilePackagePath(low) {
  const home = homedir().toLowerCase().replace(/\//g, '\\')
  const prefix = `${home}\\.dsh\\profiles\\`
  if (!low.startsWith(prefix)) return false
  // ...\profiles\<profile>\node_modules\<pkg>        — plain package
  // ...\profiles\<profile>\node_modules\@scope\<pkg> — scoped, one extra segment
  // Both shapes occur in practice (this machine has @local/…), and anything
  // deeper or shallower is not a package directory, so it is refused.
  const parts = low.slice(prefix.length).split('\\').filter(Boolean)
  // Three segments is a plain package — unless the last one is a scope, in which
  // case it is the `@scope` directory itself and deleting it would take every
  // package under it.
  if (parts.length === 3) {
    return Boolean(parts[0]) && parts[1] === 'node_modules'
      && Boolean(parts[2]) && !parts[2].startsWith('@')
  }
  if (parts.length === 4) {
    return Boolean(parts[0]) && parts[1] === 'node_modules'
      && parts[2].startsWith('@') && Boolean(parts[3])
  }
  return false
}

function isSafePath(p) {
  if (!p || !/^[a-zA-Z]:\\/.test(p)) return false
  const low = p.toLowerCase().replace(/\//g, '\\')
  // Bare roots and drive letters are never a project.
  if (low.replace(/\\+$/, '').split('\\').length < 3) return false
  if (isProfilePackagePath(low)) return true
  return allowedRoots().some((r) => low.startsWith(r))
}

/** Recursive size, unbounded: an undercount here would make a delete look cheaper. */
async function dirSize(path) {
  let bytes = 0
  let files = 0
  async function walk(p) {
    let entries
    try {
      entries = await readdir(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = join(p, e.name)
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') {
          const s = await dirSize(join(child))
          bytes += s.bytes
          files += s.files
          continue
        }
        await walk(child)
      } else if (e.isFile()) {
        try {
          const st = await stat(child)
          bytes += st.size
          files += 1
        } catch { /* racing deletion: ignore */ }
      }
    }
  }
  await walk(path)
  // `mb` is rounded for display, but `bytes` is the truth: a 32 KB project
  // rounds to 0.0 MB, and "freed 0 MB" reads as "nothing was deleted" when in
  // fact something was. Callers that report to the operator use bytes.
  return { bytes, files, mb: Math.round((bytes / 1048576) * 10) / 10 }
}

/**
 * Delete one project, after writing the `removed` record first.
 *
 * Order matters. If the record were written last, a delete that failed halfway
 * would leave a directory gone with no trace of why — exactly the "vanished"
 * state this system exists to avoid. Writing first means the worst case is a
 * record of an intent that did not complete, which is recoverable information.
 */
async function doDelete(name, why = '') {
  const preview = await previewDelete(name)
  if (!preview.ok) return preview

  const path = preview.rows[0]?.path || ''
  if (!isSafePath(path)) return { ok: false, error: '路径校验失败' }

  const watched = await readWatched()
  const rec = {
    slug: preview.slug || name,
    name,
    status: 'removed',
    removed_at: new Date().toISOString(),
    why_removed: why || '用户在设置页删除',
    size_freed_mb: preview.totalMb,
    what_was_kept: preview.workMb > 0 ? 'work-output-deleted' : 'none',
  }
  const nextWatched = watched.filter((w) => (w.slug || w.name) !== (rec.slug || rec.name))
  nextWatched.push(rec)
  await writeJson(join(WATCH_DIR, 'watched.json'), nextWatched)

  try {
    await rm(path, { recursive: true, force: true })
  } catch (err) {
    return { ok: false, error: `删除失败：${err?.message ?? err}`, record: rec }
  }

  // Drop it from the curated registry too, so the next scan does not report it
  // as vanished. The watched.json record is what keeps the history.
  try {
    const invRaw = await readText(join(WATCH_DIR, 'inventory.json'))
    if (invRaw) {
      const inv = JSON.parse(invRaw.replace(/^\uFEFF/, ''))
      inv.projects = (inv.projects || []).filter((p) => p.name !== name)
      inv.plugins = (inv.plugins || []).filter((p) => p.name !== name)
      await writeJson(join(WATCH_DIR, 'inventory.json'), inv)
    }
  } catch { /* the delete stands even if the registry edit failed */ }

  return { ok: true, name, freedMb: preview.totalMb, freedBytes: preview.totalBytes, record: rec }
}

/**
 * Update one project from upstream — but only when that is a safe thing to do.
 *
 * `git pull` on a dirty tree either fails or, worse, half-applies and leaves the
 * operator to untangle it. So the check comes first and the refusal names the
 * reason. Snapshot projects have no `.git` and are refused outright rather than
 * silently "succeeding" at nothing.
 */
async function doUpdate(name) {
  const inv = await readInventory()

  // Plugins are looked up too. They were missing here, so every plugin row's
  // Update button answered "no project by that name" — true only because the
  // search never included the list it was looking at.
  const plugin = (inv.plugins || []).find((p) => p.name === name)
  if (plugin) {
    // Attach the tag the report already found; updatePlugin falls back to its
    // own lookup only when this is missing.
    const row = (await readInventoryRows()).get(name)
    return updatePlugin({ ...plugin, upstream_tag: (row && row.upstream) || '' })
  }

  const target = inv.projects.find((p) => p.name === name)
  if (!target) return { ok: false, error: `没有名为 ${name} 的项目` }

  // A project row can be a package-manager install now. `updater` says which
  // command actually upgrades it — `git pull` would be meaningless for a venv
  // and `uv tool upgrade` meaningless for a checkout.
  const updater = String(target.updater || '').toLowerCase()
  if (updater === 'uv' || updater === 'pipx' || updater === 'npm') {
    return updatePackage(target)
  }

  const path = target.path || target.install_path || ''
  if (!isSafePath(path)) return { ok: false, error: '路径校验失败' }
  if (target.kind !== 'git') {
    return { ok: false, error: `${name} 没有 .git（${target.kind}），无法 pull。这类项目只能重新下载。` }
  }

  const gitDir = join(path, '.git')
  const hasGit = await stat(gitDir).then(() => true).catch(() => false)
  if (!hasGit) return { ok: false, error: `${path} 下没有 .git，无法 pull` }

  const before = await runGit(path, ['rev-parse', '--short', 'HEAD'])
  const dirty = await runGit(path, ['status', '--porcelain'])
  if (dirty.code === 0 && dirty.out.trim()) {
    const n = dirty.out.trim().split('\n').length
    return {
      ok: false,
      error: `有 ${n} 个未提交改动，先处理再更新（避免 pull 冲突把工作区搅乱）`,
      dirty: true,
    }
  }

  const pull = await runGit(path, ['pull', '--ff-only'])
  const after = await runGit(path, ['rev-parse', '--short', 'HEAD'])
  return {
    ok: pull.code === 0,
    name,
    code: pull.code,
    before: before.out.trim(),
    after: after.out.trim(),
    changed: before.out.trim() !== after.out.trim(),
    output: (pull.out + pull.err).trim().slice(-600),
    error: pull.code === 0 ? '' : (pull.err || pull.out).trim().slice(-400),
  }
}

/** Run one git command in a directory, never throwing. */
function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout?.on('data', (b) => { out += b.toString('utf8') })
    child.stderr?.on('data', (b) => { err += b.toString('utf8') })
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, 120000)
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

/** Same contract as runGit, for the package managers that install tools. */
function runCmd(file, args, timeoutMs = 180000, cwd = undefined) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    // On Windows the package managers are .cmd shims, and spawn does not resolve
    // those without a shell. But a resolved absolute path already names its own
    // executable: appending `.cmd` to `...\uv.exe` produced `uv.exe.cmd`, which
    // is not a file — the upgrade then "failed" for a reason that had nothing to
    // do with the package. Only add the suffix when there is none.
    const hasExt = /\.[a-z0-9]+$/i.test(file)
    const cmd = isWin && !hasExt ? file + '.cmd' : file
    // A shell is only needed to run a .cmd shim. Going through cmd.exe for a real
    // .exe splits its path on the space in "C:\Program Files" and runs
    // "C:\Program" instead — gh lives there, so its calls all failed with an
    // error about Program not being a recognized command.
    const needShell = isWin && !hasExt
    const child = spawn(cmd, args, { windowsHide: true, shell: needShell, cwd })
    let out = ''
    let err = ''
    child.stdout?.on('data', (b) => { out += b.toString('utf8') })
    child.stderr?.on('data', (b) => { err += b.toString('utf8') })
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

/**
 * Upgrade a DSH plugin.
 *
 * Only a registry install can be upgraded here. `link:` and `file:` point at a
 * directory the operator owns — there is no newer version to fetch, the working
 * copy already is it. `github:` pins a ref in the profile's package.json, so
 * moving it means rewriting that dependency line; refusing is more honest than
 * silently installing something the operator did not pin.
 */
async function updatePlugin(plugin) {
  const name = plugin.name || ''
  const source = String(plugin.install_source || 'npm').toLowerCase()
  if (!name) return { ok: false, error: '插件没有名字' }

  if (source === 'link' || source === 'file') {
    return {
      ok: false,
      error: `${name} 是本地安装（${source}），没有可拉取的上游版本；改的是那个目录本身`,
    }
  }
  // A `github:` install pins a ref in the profile's package.json
  // (`github:owner/repo#v0.13.0`), so it does have an upstream — the tag — and
  // upgrading means rewriting that pin. Refusing here was wrong: the checker
  // reports the newer tag, so the button has to be able to act on it.
  let spec = null
  if (source === 'github') {
    const declared = readDeclaredSpec(name)
    const m = /^github:([^#]+)(?:#(.+))?$/.exec(declared || '')
    if (!m) {
      return { ok: false, error: `${name} 的依赖声明不是 github: 形式（${declared || '空'}）` }
    }
    const repo = m[1]
    // The checker already recorded the newest tag (that is where the "有更新"
    // badge came from), so reuse it instead of spending another API call — the
    // anonymous quota is 60/hour and this is exactly the moment it is empty.
    let latest = String(plugin.upstream_tag || '').trim()
    if (!latest) {
      const got = await latestTagFor(repo)
      if (got.tag) latest = got.tag
      else {
        return {
          ok: false,
          error: `${name} 需要升级到哪个版本无法确定：${got.reason || '查不到上游 tag'}`,
        }
      }
    }
    // `#v0.13.2` and `#0.13.2` both work; keep the tag's own spelling.
    spec = `github:${repo}#${latest}`
  }

  const target = spec ? spec : name + '@latest'

  // Let the profile's own package manager move it. Prefer the bundled pnpm
  // through the bundled node; fall back to PATH for deployments that install
  // it normally.
  let res
  if (existsSync(PNPM_CLI) && existsSync(NODE_EXE)) {
    res = await runCmd(NODE_EXE, [PNPM_CLI, 'add', target,
                                  '--config.minimumReleaseAge=0'], 300000, PROFILE_DIR)
  } else {
    res = await runCmd('pnpm', ['add', target,
                                '--config.minimumReleaseAge=0'], 300000, PROFILE_DIR)
  }
  const blob = ((res.out || '') + (res.err || '')).trim()
  const ok = res.code === 0
  return {
    ok,
    name,
    changed: ok && /\+\s/.test(blob),
    code: res.code,
    error: ok ? undefined : blob.slice(0, 300) || ('退出码 ' + res.code),
    output: blob.slice(-400),
    restartRequired: ok,
  }
}

/** The dependency spec the profile declares for a package, or ''. */
function readDeclaredSpec(name) {
  try {
    const raw = readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw.replace(/^\uFEFF/, ''))
    const deps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) }
    return deps[name] || ''
  } catch {
    return ''
  }
}

/** Newest release tag of a repository, as a ref suitable for `github:…#<ref>`. */
async function latestTagFor(repo) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'user-agent': 'dsh-github-watch', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000),
    })
    if (res.status === 403 || res.status === 429) {
      // Out of anonymous quota. Saying "no tag found" here is a lie that sends
      // the operator looking for a tagging problem; the answer arrives in an
      // hour, not never.
      const reset = res.headers.get('x-ratelimit-reset')
      const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : '稍后'
      return { tag: '', reason: `GitHub API 额度用完（60 次/小时），${when} 后重试` }
    }
    if (res.ok) {
      const d = await res.json()
      const tag = String(d.tag_name || '').trim()
      if (tag) return { tag }
    }
    const res2 = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=30`, {
      headers: { 'user-agent': 'dsh-github-watch', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000),
    })
    if (res2.status === 403 || res2.status === 429) {
      const reset = res2.headers.get('x-ratelimit-reset')
      const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : '稍后'
      return { tag: '', reason: `GitHub API 额度用完（60 次/小时），${when} 后重试` }
    }
    if (!res2.ok) return { tag: '', reason: `仓库不可达（HTTP ${res2.status}）` }
    const tags = await res2.json()
    const nums = tags
      .map((t) => String(t.name || '').trim())
      .filter((n) => /^v?\d/.test(n))
      .map((n) => ({ raw: n, key: n.replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0) }))
    if (!nums.length) return { tag: '', reason: '仓库没有 release 也没有版本 tag' }
    nums.sort((a, b) => {
      for (let i = 0; i < Math.max(a.key.length, b.key.length); i++) {
        const d = (a.key[i] || 0) - (b.key[i] || 0)
        if (d) return d
      }
      return 0
    })
    return { tag: nums[nums.length - 1].raw }
  } catch (err) {
    return { tag: '', reason: '请求失败: ' + String(err && err.message ? err.message : err) }
  }
}

/**
 * Where `uv` lives. Its installer puts it in ~/.local/bin, which this process's
 * PATH does not include — the bare name would answer ENOENT.
 */
function resolveUv() {
  const cands = [
    join(homedir(), '.local', 'bin', 'uv.exe'),
    join(homedir(), '.local', 'bin', 'uv'),
    join(homedir(), '.cargo', 'bin', 'uv.exe'),
  ]
  for (const p of cands) {
    if (existsSync(p)) return p
  }
  return 'uv'
}

/**
 * Upgrade a package-manager install. `updater` is already known to be one of
 * uv / pipx / npm, so the branch here is only about which command to run.
 */
async function updatePackage(project) {
  const name = project.name || ''
  const updater = String(project.updater || '').toLowerCase()
  if (!name) return { ok: false, error: '条目没有名字' }

  let res
  if (updater === 'uv') {
    // `uv` is installed by its own installer into ~/.local/bin, which is not on
    // PATH here. Falling back to the bare name answers ENOENT and reads as a
    // failed upgrade for a reason unrelated to the package.
    res = await runCmd(resolveUv(), ['tool', 'upgrade', name])
  } else if (updater === 'pipx') {
    res = await runCmd('pipx', ['upgrade', name])
  } else if (updater === 'npm') {
    // A package with a postinstall script is refused by npm's allow-scripts
    // policy. `bun` is exactly that, and the refusal is a one-line warning that
    // otherwise looks like a silent no-op.
    res = await runCmd('npm', ['install', '-g', name + '@latest',
                               '--allow-scripts=' + name])
  } else {
    return { ok: false, error: `未知的升级方式：${project.updater || '(空)'}` }
  }

  const blob = ((res.out || '') + (res.err || '')).trim()
  const ok = res.code === 0
  // A tool that a running MCP server has open cannot have its files replaced:
  // uv reports EPERM / "拒绝访问" while the process holds the directory. That is
  // not a broken command, it is a blocked one — saying so is what makes the
  // Restart button make sense.
  const locked = !ok && /拒绝访问|Access is denied|os error 5|EPERM|being used by another process/i.test(blob)
  return {
    ok,
    name,
    updater,
    changed: ok && !/Requirement already satisfied|Nothing to upgrade/i.test(blob),
    code: res.code,
    error: ok ? undefined : blob.slice(0, 300) || `退出码 ${res.code}`,
    output: blob.slice(0, 300),
    locked,
    restartRequired: ok || locked,
    restartHint: locked
      ? '文件被正在运行的进程占用，重启 DSH 后再试一次'
      : (ok ? '重启 DSH 后新版本才会加载' : undefined),
  }
}

/**
 * Re-run the scan and the checker after an upgrade changed something.
 *
 * All three steps run, including the disk walk. An earlier version skipped the
 * walk here to save a second — "the directories did not move, only their contents
 * changed" — but the walk is exactly what reads the installed versions off disk.
 * Skipping it produced the bug it was meant to avoid: a freshly installed version
 * never reached inventory.json, because the file `build` merges still held the old
 * number.
 */
async function rescanAfterUpdate() {
  const steps = ['inventory', 'build', 'check']
  const out = []
  for (const step of steps) {
    const res = await runStepSync(step)
    out.push({ step, code: res.code, tail: ((res.out || '') + (res.err || '')).slice(-200) })
    // `check`'s 1 means "some project failed to check", which the report shows;
    // the two steps before it have no such meaning and must succeed.
    if (step === 'check') return { ok: res.code === 0 || res.code === 1, steps: out }
    if (res.code !== 0) return { ok: false, steps: out }
  }
  return { ok: true, steps: out }
}

/** Run one scan step to completion and wait for it. */
function runStepSync(step) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [join(LIB_DIR, 'run.mjs'), step], {
        cwd: WATCH_DIR,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
    } catch (err) {
      return resolve({ code: -1, out: '', err: String(err) })
    }
    let out = ''
    let err = ''
    child.stdout?.on('data', (b) => { out += b.toString('utf8') })
    child.stderr?.on('data', (b) => { err += b.toString('utf8') })
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, 180000)
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

/**
 * Restart the host application.
 *
 * A plugin cannot reload the process it runs inside, so this hands the job to
 * the OS: spawn a detached helper that waits for this process to exit, then
 * starts the same executable again. The helper is a shell one-liner on purpose —
 * a second copy of this plugin living in a temp file would be a worse thing to
 * leave behind than the command that starts it.
 *
 * Returns before the restart happens: the caller gets a response, then the
 * window closes. A wait-for-exit loop in the helper is what keeps the new
 * instance from fighting the old one for the single-instance lock.
 */
async function doRestart() {
  // Deliberately does NOT try to restart the host.
  //
  // An earlier version spawned a second copy and then called process.exit(0).
  // That crashes the app: this plugin runs inside the Electron host, so exiting
  // tears down the process without the host's own shutdown — single-instance
  // lock, ports and session state all left dangling, and the new copy raced the
  // dying one for them. The result was "应用无法启动或已意外停止" on the next launch.
  //
  // The host owns its lifecycle; a plugin cannot hand it over cleanly. So this
  // endpoint reports what the operator has to do instead of doing it badly.
  return {
    ok: false,
    manual: true,
    error: '请手动关闭 DSH 再重新打开（插件无法安全地重启宿主进程）',
  }
}

/** Read a JSON request body, tolerating an empty or malformed one. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (b) => {
      raw += b.toString('utf8')
      if (raw.length > 1e6) { try { req.destroy() } catch { /* gone */ } }
    })
    req.on('end', () => {
      if (!raw.trim()) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * Mute or unmute one project.
 *
 * Muting means "stop checking this for updates" — it does NOT hide the row and
 * does NOT touch the files. Both halves matter:
 *
 *   hiding the row would leave the operator unable to find the project again,
 *   and unable to tell "I muted it" from "it is gone"
 *   touching the files would be a delete wearing another name
 *
 * So this only flips a flag in inventory.json. The check step reads it and empties the
 * probe list, which is what actually stops the network calls.
 */
async function setMuted(name, muted) {
  const invRaw = await readText(join(WATCH_DIR, 'inventory.json'))
  if (!invRaw) return { ok: false, error: 'inventory.json 读不到' }

  let inv
  try {
    inv = JSON.parse(invRaw.replace(/^\uFEFF/, ''))
  } catch (err) {
    return { ok: false, error: `inventory.json 解析失败：${err?.message ?? err}` }
  }

  let found = false
  // Tools are intentionally absent from this loop. Muting means "stop loading
  // this DSH plugin"; a command-line tool has no load step to suppress, so
  // offering the action would promise an effect it cannot have.
  for (const list of [inv.projects || [], inv.plugins || []]) {
    for (const p of list) {
      if (p.name === name) {
        if (muted) p.muted = true
        else delete p.muted
        found = true
      }
    }
  }
  if (!found) return { ok: false, error: `没有名为 ${name} 的项目` }

  await writeJson(join(WATCH_DIR, 'inventory.json'), inv)
  return { ok: true, name, muted }
}

async function writeJson(path, data) {
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

async function snapshot() {
  const [md, reportStat, lastRun, blurbs, inventory, queue, watched] = await Promise.all([
    readText(join(WATCH_DIR, 'report.md')),
    stat(join(WATCH_DIR, 'report.md')).catch(() => null),
    readLastRun(),
    readDescriptions(),
    readInventory(),
    readQueue(),
    readWatched(),
  ])
  // `queue` is read but not served: the build step folds reported downloads
  // into inventory.projects, so a separate list would show them twice — once as
  // "pending" and once as a real row. It stays read-only reference here.
  void queue
  const report = parseReport(md)

  // A project the operator uninstalled leaves a `removed` record in watched.json.
  // Without it, "directory gone" is indistinguishable from "check broke", and the
  // page would show ⚠ 检查失败 for a deliberate deletion — the exact confusion
  // this distinction exists to prevent.
  const removedBySlug = new Map()
  for (const w of watched) {
    if (w.status === 'removed' && (w.slug || w.name)) {
      removedBySlug.set((w.slug || w.name).toLowerCase(), w)
    }
  }

  // Join status onto the curated rows rather than the other way round. The
  // report is a measurement, inventory.json is the decision about what belongs
  // on the page: a project the operator removed (the second autoforge clone, the
  // dsh-purge fork) must not reappear just because the checker still sees it.
  const byName = new Map(report.rows.map((r) => [r.project, r]))
  const projects = inventory.projects.map((p) => {
    const hit = byName.get(p.name)
    const { lead, rest } = splitBlurb(blurbs[p.name])

    // Four different things used to render as the same ⚠ 检查失败:
    //   removed     — the operator uninstalled it (a decision, and a good one)
    //   vanished    — the directory is gone but nobody recorded deleting it
    //   failed      — the check itself broke (network, permissions)
    //   missing-dep — a dependency went away, the project is still there
    // Only the first is a fact about intent; the rest are unknowns, and the page
    // has to say which is which or none of them can be acted on.
    const removed = removedBySlug.get((p.slug || p.name).toLowerCase())
    const gone = p.exists === false
    // A directory that is not on disk has no row here. "目录不见了" asked a
    // question this page cannot answer — either the operator deleted it (fine,
    // watched.json still records that) or something else did (not a project to
    // manage). Neither belongs in a list of what you have.
    if (gone) return null
    // A muted project is not checked, so the report has no status for it. Saying
    // "未检查" would be honest but useless — the reason is that the operator
    // muted it, and that is what the row should say.
    const muted = Boolean(p.muted)
    let status = hit ? hit.status : (gone ? '目录不存在' : '未检查')
    let detail = hit ? hit.detail : ''
    let state = 'ok'
    if (removed) {
      state = 'removed'
      status = '已卸载'
      detail = [
        removed.why_removed || '',
        removed.removed_at ? '卸载于 ' + String(removed.removed_at).replace('T', ' ').slice(0, 16) : '',
        removed.size_freed_mb ? '释放 ' + removed.size_freed_mb + ' MB' : '',
      ].filter(Boolean).join(' ｜ ')
    } else if (gone) {
      state = 'vanished'
      status = '目录不见了'
      detail = '清单里有，磁盘上没有，也没有卸载记录 —— 是挪走了、还是被别的东西删了？'
    } else if (muted) {
      state = 'muted'
      status = '已屏蔽'
      detail = '不检查更新；项目本身仍在磁盘上，随时可以取消屏蔽'
    }

    return {
      name: p.name,
      kind: p.kind || 'git',
      slug: p.slug || '',
      path: p.path || '',
      // What it is and where it came from, so a row that says "有更新" also says
      // whether that update is a git pull or a package upgrade. `updater` is
      // what the Update button dispatches on.
      version: p.version || '',
      source: p.source || '',
      updater: p.updater || '',
      summary: hit ? (hit.summary || '') : '',
      aliases: p.aliases_present || [],
      note: p.note || '',
      state,
      status,
      detail,
      // The manifest's own one-liner (already trimmed to the row's budget by
      // build step) wins over a hand-written blurb: it is what the
      // project says about itself, and it exists for every row rather than only
      // the ones someone annotated.
      description: p.description || lead,
      descriptionRest: p.description ? '' : rest,
      // Sizes and dependencies travel with the row so the page can answer the
      // question this list exists for: what is big, and what does it need. The
      // two totals are separate on purpose — `size_mb` is re-downloadable
      // software, `work_mb` is analysis output that cannot be fetched again.
      sizeMb: p.size_mb || 0,
      sourceMb: p.source_mb || 0,
      depsMb: p.deps_mb || 0,
      deps: (p.deps || []).map((d) => ({
        name: d.name, why: d.why || '', sizeMb: d.size_mb || 0,
        exists: d.exists !== false, local: Boolean(d.local),
      })),
      work: p.work ? {
        path: p.work.path, why: p.work.why || '',
        sizeMb: p.work.size_mb || 0,
        items: (p.work.items || []).map((it) => ({ name: it.name, sizeMb: it.size_mb || 0 })),
      } : null,
      workMb: p.work_mb || 0,
    }
  }).filter(Boolean)

  // Plugins are not cloned, so there is no HEAD to compare: the honest signal is
  // the installed version against the upstream one. Every kind of row counts —
  // filtering to `kind === 'npm'` here is what made a `link:` or `github:`
  // plugin show "未检查" while the report already contained a row explaining
  // exactly why it had no upstream. The checker had done its job; this line
  // threw the answer away.
  const pluginRows = new Map(report.rows.map((r) => [r.project, r]))
  const plugins = inventory.plugins.map((p) => {
    const hit = pluginRows.get(p.name)
    const { lead, rest } = splitBlurb(blurbs[p.name])
    // Plugins get the same `state` treatment as projects. Without it a muted
    // plugin had `state === undefined`, so the client's `active` filter never
    // matched and the row stayed in the 插件 tab no matter how many times it was
    // muted — the mute was written to inventory.json correctly and then ignored
    // on the way out.
    const muted = Boolean(p.muted)
    return {
      name: p.name,
      slug: p.slug || '',
      // Plugins are installed into a profile, so their location is `install_path`
      // and there is no `path`. Omitting it left the row with no location at all —
      // the expanded view showed nothing, and a delete had nothing to point at.
      path: p.install_path || p.path || '',
      version: p.installed_version || p.version || '',
      installed: p.installed !== false,
      note: p.note || '',
      // Carried through so doUpdate can build `github:repo#tag` without a second
      // API round-trip.
      upstream_tag: hit ? (hit.upstream || '') : '',
      summary: hit ? (hit.summary || '') : '',
      state: muted ? 'muted' : 'ok',
      status: muted ? '已屏蔽' : (hit ? hit.status : '未检查'),
      detail: muted
        ? '不检查更新；插件仍在 profile 里，随时可以取消屏蔽'
        : (hit ? hit.detail : (p.note || '')),
      description: p.description || lead,
      descriptionRest: p.description ? '' : rest,
    }
  })

  // Standalone binaries: nothing to diff, so the honest status is "已安装" with
  // the version read off the file itself (done by the build step, which
  // runs `<tool> --version`). They are listed because the page's job is "what do
  // I have", not "what is in git".
  const tools = (inventory.tools || []).map((t) => ({
    name: t.name,
    slug: t.slug || '',
    version: t.version || '',
    path: t.path || '',
    why: t.why || '',
    sizeMb: t.size_mb || 0,
    status: t.exists === false ? '文件不存在' : '已安装',
  }))

  // `discovered` is the safety net: a project the scan found on disk that no
  // curated row and no session reported. It exists because the skill-based
  // reporting depends on another window's model choosing to follow the rule —
  // if it does not, the page would otherwise show nothing and the operator could
  // not tell "nothing was downloaded" from "something was downloaded and missed".
  const discovered = (inventory.discovered || []).map((d) => ({
    name: d.name || '',
    slug: d.slug || '',
    path: d.path || '',
    kind: d.kind || 'git',
    sizeMb: d.sizeMb || 0,
    description: d.description || '',
  }))

  const counts = report.counts || {}
  return {
    ok: Boolean(md),
    watchDir: WATCH_DIR,
    reportMtime: reportStat ? reportStat.mtime.toISOString() : null,
    generatedAt: report.generatedAt,
    scannedAt: inventory.scannedAt || null,
    counts,
    lastRun,
    projects,
    plugins,
    tools,
    discovered,
    discoveredCount: discovered.length,
    // The GitHub account the checker spends its quota as, and the login attempt
    // in flight. The account is read WITHOUT waiting: `ghPeek()` returns whatever
    // is already known and refreshes in the background, because a 1.6 s network
    // round trip has no business delaying a list of local files. The page asks
    // for the account separately (GET /api/github) so it can paint the rows first
    // and let the card fill in. A null here means "not read yet", which the page
    // shows as nothing rather than as "not logged in".
    github: {
      ...(ghPeek() || {}),
      pending: !ghCache.value,
      login: {
        running: ghLogin.running,
        code: ghLogin.code,
        url: ghLogin.url,
        ok: ghLogin.ok,
        error: ghLogin.error,
        startedAt: ghLogin.startedAt,
        finishedAt: ghLogin.finishedAt,
      },
    },
    missing: !md,
    // Kept for callers that still read the flat list.
    rows: report.rows,
  }
}

export const route = {
  kind: 'prefix',
  path: '/github-watch',
  handler: async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/github-watch/api/')) return next()

    const send = (code, body) => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    }

    try {
      if (url.pathname === '/github-watch/api/projects' && req.method === 'GET') {
        return send(200, await snapshot())
      }
      // -- destructive and remote-touching operations -----------------------
      // Both are POST with a JSON body, and both answer with the full result
      // rather than a bare 200: the page has to show what happened per item,
      // including the ones that were refused and why.
      if (url.pathname === '/github-watch/api/preview-delete' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return send(200, await previewDelete(String(body.name || '')))
      }
      if (url.pathname === '/github-watch/api/delete' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const names = Array.isArray(body.names) ? body.names : [body.name]
        const results = []
        for (const n of names.filter(Boolean)) {
          results.push(await doDelete(String(n), String(body.why || '')))
        }
        return send(200, { ok: results.every((r) => r.ok), results })
      }
      if (url.pathname === '/github-watch/api/mute' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const names = Array.isArray(body.names) ? body.names : [body.name]
        const muted = body.muted !== false      // default: mute
        const results = []
        for (const n of names.filter(Boolean)) {
          results.push(await setMuted(String(n), muted))
        }
        return send(200, { ok: results.every((r) => r.ok), results })
      }
      if (url.pathname === '/github-watch/api/update' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const names = Array.isArray(body.names) ? body.names : [body.name]
        const results = []
        for (const n of names.filter(Boolean)) {
          results.push(await doUpdate(String(n)))
        }
        // `restartNeeded` is what the page uses to offer the button: any entry
        // that changed a package needs a reload before the new files are read.
        const restartNeeded = results.some((r) => r && r.restartRequired)
        const locked = results.filter((r) => r && r.locked).map((r) => r.name)

        // Rebuild the inventory in place. Without this the page kept showing the
        // version from before the upgrade: the package on disk was new, but
        // inventory.json still held the old number, so the row said "有更新"
        // forever. The update knows exactly what it changed, so it is the right
        // place to refresh the record — waiting for the operator to press Scan
        // is how a finished upgrade looks unfinished.
        const changed = results.filter((r) => r && r.changed).map((r) => r.name)
        let rescan = null
        if (changed.length) {
          rescan = await rescanAfterUpdate()
        }

        return send(200, {
          ok: results.every((r) => r.ok),
          results,
          restartNeeded,
          locked,
          rescanned: Boolean(rescan && rescan.ok),
          rescan,
        })
      }
      if (url.pathname === '/github-watch/api/restart' && req.method === 'POST') {
        return send(200, await doRestart())
      }
      // POST starts the pipeline; it returns at once with {"started":true}.
      // The work is ~12 s of disk walking plus network probes — past any sane
      // request timeout — so the browser polls GET below instead of holding a
      // socket open.
      if (url.pathname === '/github-watch/api/scan' && req.method === 'POST') {
        return send(200, startScan())
      }
      if (url.pathname === '/github-watch/api/scan' && req.method === 'GET') {
        // The `check` step writes per-project progress to scan_progress.json as it
        // goes. Without it the bar would sit at one fixed percentage for ~9 s,
        // since that single step is most of the wall clock.
        let sub = null
        if (scanState.running && scanState.step === 'check') {
          const raw = await readText(join(WATCH_DIR, 'scan_progress.json'))
          if (raw) {
            try {
              const p = JSON.parse(raw.replace(/^\uFEFF/, ''))
              if (p && p.total) {
                sub = { done: p.done || 0, total: p.total, current: p.current || '' }
              }
            } catch { sub = null }
          }
        }
        // The check step owns the last 68 %; fold its own fraction in so the bar
        // moves once per project rather than once per step.
        let progress = scanState.progress
        if (sub) {
          const before = scanState.progress
          const span = SCAN_STEPS[SCAN_STEPS.length - 1].weight
          progress = before + span * (sub.done / sub.total)
        }
        return send(200, {
          running: scanState.running,
          step: scanState.step,
          stepIndex: scanState.stepIndex,
          progress,
          sub,
          totalSteps: SCAN_STEPS.length,
          startedAt: scanState.startedAt || null,
          finishedAt: scanState.finishedAt || null,
          error: scanState.error,
          output: scanState.output,
        })
      }
      if (url.pathname === '/github-watch/api/raw' && req.method === 'GET') {
        const md = await readText(join(WATCH_DIR, 'report.md'))
        res.statusCode = md ? 200 : 404
        res.setHeader('content-type', 'text/markdown; charset=utf-8')
        return res.end(md || '尚未生成报告')
      }
      // -- GitHub account ---------------------------------------------------
      // The credential stays in gh's own store (Windows Credential Manager).
      // These endpoints start a browser authorization and read back its result;
      // no token is ever returned, because none is ever needed here.
      //
      // Reading the account costs a network round trip through gh (~1.6 s), so
      // this endpoint never awaits one. It returns whatever is cached and, when
      // that is nothing, kicks off a read that the next poll (or the next page
      // load) picks up. The page therefore paints instantly and the card fills
      // in a moment later; `pending` is how it knows the difference between
      // "not read yet" and "read, and nobody is logged in".
      if (url.pathname === '/github-watch/api/github' && req.method === 'GET') {
        return send(200, {
          ...(ghPeek() || {}),
          pending: !ghCache.value,
          login: {
            running: ghLogin.running,
            code: ghLogin.code,
            url: ghLogin.url,
            ok: ghLogin.ok,
            error: ghLogin.error,
          },
        })
      }
      if (url.pathname === '/github-watch/api/github/refresh' && req.method === 'POST') {
        // Explicit re-read, e.g. after the user ran `gh auth login` in their own
        // terminal rather than through this page.
        forgetGhStatus()
        return send(200, await ghStatus())
      }
      if (url.pathname === '/github-watch/api/github/login' && req.method === 'POST') {
        // The authorization blocks until a human finishes in the browser, which
        // is minutes not milliseconds, so the call returns the code and the page
        // polls GET /api/github until `loggedIn` flips.
        return send(200, await startGhLogin())
      }
      if (url.pathname === '/github-watch/api/github/cancel' && req.method === 'POST') {
        return send(200, cancelGhLogin())
      }
      return send(404, { error: 'unknown endpoint' })
    } catch (err) {
      return send(500, { error: String(err?.message ?? err) })
    }
  },
}

export function apply(ctx) {
  // The webserver is provided asynchronously and only in GUI profiles, so it is
  // requested here instead of declared in `inject`.
  //
  // `ctx.get('webServer')` at apply-time is NOT equivalent: it returns undefined
  // while the service has not been provided yet, so the first version of this
  // plugin took its "no webserver" branch, registered nothing, and every request
  // 404'd. `ctx.inject` waits for the service; `webCtx.effect` ties the route's
  // lifetime to it.
  ctx.effect(() => ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register(route), 'github-watch: route')
  }), 'github-watch: webServer')
}
