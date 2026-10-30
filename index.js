/**
 * GitHub Watch — host half.
 *
 * The checking is not this plugin's job: `github-watch\check.py` already does it
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
import { readFileSync, existsSync } from 'node:fs'
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
 * Which interpreter runs the scan scripts.
 *
 * `spawn('python', ...)` is not reliable on Windows: the Microsoft Store
 * alias `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` sits on PATH ahead of
 * a real install and exits with "Python was not found", so every step would
 * fail with a message about the Store instead of about the scan. Resolution
 * order, first hit wins:
 *
 *   1. DSH_GITHUB_WATCH_PYTHON  — explicit override
 *   2. config.json `python`     — the same file that supplies watchDir
 *   3. python3 / python         — whatever PATH really resolves to
 */
function resolvePython() {
  const fromEnv = process.env.DSH_GITHUB_WATCH_PYTHON
  if (fromEnv) return fromEnv
  try {
    const cfg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'config.json'), 'utf8'))
    if (cfg && typeof cfg.python === 'string' && cfg.python) return cfg.python
  } catch { /* no config yet */ }
  for (const name of ['python3', 'python']) {
    const found = whichSync(name)
    if (found) return found
  }
  return 'python'
}

/** `where`-style lookup: returns the first non-Store-alias hit, or ''. */
function whichSync(name) {
  const raw = process.env.PATH || process.env.Path || ''
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
  const storeAlias = /\\WindowsApps\\python3?\.exe$/i
  const hits = []
  for (const dir of raw.split(';')) {
    if (!dir.trim()) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase())
      if (existsSync(candidate)) hits.push(candidate)
    }
  }
  // Prefer a real interpreter; fall back to the alias only if it is all there is.
  return hits.find((p) => !storeAlias.test(p)) || hits[0] || ''
}

const PYTHON = resolvePython()

/**
 * The scan pipeline, in order. Each step reads the previous step's file, so the
 * order is not cosmetic: inventory_local.py writes local_inventory.json,
 * build_inventory.py reads it plus the curated source and writes inventory.json,
 * check.py reads inventory.json and writes report.md.
 *
 * A full run walks the disk, so it takes ~35 s. The HTTP handler therefore does
 * not wait for it — see startScan/scanState below.
 *
 * `weight` is measured, not guessed: on this machine the three steps take about
 * 2 s, 1 s and 32 s. A progress bar that advanced one third per step would sit
 * at 100 % for 32 of the 35 seconds, which reads as a hang. These fractions make
 * the bar track elapsed work instead of counting steps.
 */
const SCAN_STEPS = [
  { file: 'inventory_local.py', weight: 0.30 },
  { file: 'build_inventory.py', weight: 0.08 },
  { file: 'check.py', weight: 0.62 },
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

/** Run one python file, resolving with its exit code and last lines of output. */
function runStep(file) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [join(WATCH_DIR, file)], {
      cwd: WATCH_DIR,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
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
    // A hung python must not wedge the state forever: kill it after 5 minutes.
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
    }, 300000)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, tail, error: String(err?.message ?? err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // check.py returns 1 when any project failed to check. That is a finding,
      // not a crash of the pipeline, so it is recorded and the run continues.
      resolve({ code, tail, error: stderr.trim().slice(-400) })
    })
  })
}

/** Kick the pipeline off in the background. Returns immediately. */
function startScan() {
  if (scanState.running) return { started: false, reason: 'already running' }

  scanState = {
    running: true, startedAt: Date.now(), finishedAt: 0,
    step: SCAN_STEPS[0].file, stepIndex: 0, progress: 0, error: '', output: [],
  }

  ;(async () => {
    let done = 0
    for (let i = 0; i < SCAN_STEPS.length; i += 1) {
      const { file, weight } = SCAN_STEPS[i]
      scanState.step = file
      scanState.stepIndex = i
      scanState.progress = done
      const res = await runStep(file)
      scanState.output.push({ step: file, code: res.code, tail: res.tail })
      // inventory_local.py and build_inventory.py must succeed; check.py's 1 is
      // an acceptable outcome (some project failed, which the report shows).
      const fatal = i < 2 && res.code !== 0
      if (fatal) {
        scanState.error = res.error || `${file} 退出码 ${res.code}`
        break
      }
      done += weight
      scanState.progress = done
    }
    scanState.progress = 1
    scanState.running = false
    scanState.finishedAt = Date.now()
    scanState.step = ''
    // scan_progress.json is deliberately left on disk. check.py rewrites it from
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
 * Parse the markdown table check.py writes. Columns: 项目 | 类型 | 状态 | 说明.
 * The prose above the table is for a human reading the file; the table is the
 * part worth parsing.
 */
function parseReport(md) {
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
    const cells = raw.match(/^\|\s*(.+?)\s*\|\s*(git|npm|snapshot|local)\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|$/)
    if (!cells) continue
    const [, project, kind, statusRaw, detail] = cells
    // The status cell carries a leading emoji; strip it, keep the words.
    const status = statusRaw.replace(/^[^\p{L}\p{N}]+/u, '').trim()
    if (!status) continue
    rows.push({ project, kind, status, detail })
  }
  return { generatedAt, counts, rows }
}

/** Last line of run.log: when check.py last ran and what it found. */
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
function splitBlurb(text) {
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
  const all = [...inv.projects, ...inv.plugins]
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
  const target = inv.projects.find((p) => p.name === name)
  if (!target) return { ok: false, error: `没有名为 ${name} 的项目` }

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
 * So this only flips a flag in inventory.json. check.py reads it and empties the
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
      aliases: p.aliases_present || [],
      note: p.note || '',
      state,
      status,
      detail,
      description: lead,
      descriptionRest: rest,
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
  })

  // Plugins are not cloned, so there is no HEAD to compare: the honest signal is
  // the installed version against the upstream one, and only the checker's npm
  // rows carry that. Anything else says "未检查" rather than pretending.
  const npmBySlug = new Map(report.rows.filter((r) => r.kind === 'npm')
    .map((r) => [r.project, r]))
  const plugins = inventory.plugins.map((p) => {
    const hit = npmBySlug.get(p.name)
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
      state: muted ? 'muted' : 'ok',
      status: muted ? '已屏蔽' : (hit ? hit.status : '未检查'),
      detail: muted
        ? '不检查更新；插件仍在 profile 里，随时可以取消屏蔽'
        : (hit ? hit.detail : (p.note || '')),
      description: lead,
      descriptionRest: rest,
    }
  })

  // Standalone binaries: nothing to diff, so the honest status is "已安装" with
  // the version read off the file itself (done by build_inventory.py, which
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
    queue,
    discovered,
    queueCount: queue.length,
    discoveredCount: discovered.length,
    missing: !md,
    // Kept for callers that still read the flat list.
    rows: report.rows,
  }
}

const route = {
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
        return send(200, { ok: results.every((r) => r.ok), results })
      }
      // POST starts the pipeline; it returns at once with {"started":true}.
      // The work is 40 s of disk walking — far past any sane request timeout —
      // so the browser polls GET below instead of holding a socket open.
      if (url.pathname === '/github-watch/api/scan' && req.method === 'POST') {
        return send(200, startScan())
      }
      if (url.pathname === '/github-watch/api/scan' && req.method === 'GET') {
        // check.py writes per-project progress to scan_progress.json as it goes.
        // Without it the bar would sit at one fixed percentage for ~30 s, since
        // that single step is most of the wall clock.
        let sub = null
        if (scanState.running && scanState.step === 'check.py') {
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
        // The check step owns the last 62 %; fold its own fraction in so the bar
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
