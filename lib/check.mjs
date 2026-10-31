/**
 * Update checker — one row per project, with skills and plugins folded into the
 * project they belong to.
 *
 * Design points, all of them learned the hard way:
 *   * Group by repository, not by local directory. The same project may be cloned
 *     three times (autoforge is); the report shows one row and lists the clones
 *     beside it.
 *   * "Out of date" means the upstream commit sha differs from the local HEAD —
 *     not a tag comparison and not a date comparison.
 *   * Each project gets one probe strategy, degrading by capability:
 *         git      -> git ls-remote (private repos need a token)
 *         api      -> GitHub REST commits?per_page=1
 *         tags     -> releases/tags API, for a plugin with no .git
 *         npm      -> registry dist-tag
 *         pypi     -> PyPI JSON API
 *         release  -> latest release tag, for a downloaded binary
 *         none     -> nothing to compare against (self-built, muted); listed
 *                     rather than pretending it is up to date
 *   * Use a token when there is one, anonymous otherwise (60/hour). An exhausted
 *     quota is reported, never silently swallowed.
 *
 * Usage:
 *     node lib/check.mjs             # check and write report.md
 *     node lib/check.mjs --no-write  # print only
 *     node lib/check.mjs --force     # ignore the cache
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, readdirSync, statSync, renameSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureWatchDir,
  appdata,
  home,
  isdir,
  isfile,
} from './config.mjs'
import { loadJson, writeJson, normcase, stampShort, isoLocal } from './util.mjs'

// ensure* rather than watchDir: the directory may not exist yet on a clean
// install, and the first thing this step does with it is write report.md.
const BASE = ensureWatchDir()
const STATE = join(BASE, 'state.json')
const REPORT = join(BASE, 'report.md')

// How long a finished check stays authoritative. The upstream facts this plugin
// tracks (a release, a commit) do not change minute to minute, and the anonymous
// GitHub API allows 60 requests/hour, so re-checking within a few minutes burns
// the budget to learn nothing. `--force` overrides it.
const CACHE_TTL_SECONDS = 6 * 3600

// Concurrent upstream probes. Kept small: the anonymous GitHub API allows 60
// requests/hour, and eight parallel git ls-remote calls already saturate a home
// connection. Raising this trades GitHub rate-limit risk for little wall clock.
const PROBE_WORKERS = 8

const UA = 'dsh-github-watch/1.0'

// ── token ────────────────────────────────────────────────────────────────
/**
 * Where to find a token, in the order that needs the least configuration.
 *
 * Anonymous access allows 60 requests an hour, which one scan of this machine
 * nearly exhausts (each entry costs two: releases/latest, then tags). A token
 * raises it to 5000 — the same call, just authenticated.
 *
 * Sources tried:
 *   1. environment  — explicit and portable; what CI and scripts use
 *   2. gh CLI       — the one that needs no extra setup once `gh auth login` has
 *                     run: the token lives in the OS keyring and gh reads it
 *   3. git credentials — the older plaintext store, kept for machines set up that
 *                     way before gh was common
 */
function githubToken() {
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT']) {
    if (process.env[key]) return String(process.env[key]).trim()
  }

  // `gh auth token` prints the stored token and nothing else on success. It exits
  // non-zero when no account is logged in, which is simply "try the next source"
  // rather than an error worth reporting.
  const programFiles = process.env.ProgramFiles || ''
  const ghCandidates = ['gh']
  if (programFiles) ghCandidates.push(join(programFiles, 'GitHub CLI', 'gh.exe'))
  for (const gh of ghCandidates) {
    const r = spawnSync(gh, ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    })
    if (r.error) continue
    const tok = (r.stdout || '').trim()
    if (r.status === 0 && tok) return tok
  }

  try {
    const text = readFileSync(join(home(), '.git-credentials'), 'utf8')
    for (const line of text.split('\n')) {
      const m = /^https:\/\/([^:]+):([^@]+)@github\.com/.exec(line.trim())
      if (m) return m[2]
    }
  } catch {
    /* no plaintext store: the two sources above cover the common setups */
  }
  return ''
}

const TOKEN = githubToken()

function hhmm(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * GET api.github.com. Returns [data, error]. An exhausted quota is stated
 * explicitly instead of looking like an empty answer.
 */
async function api(path, timeout = 25) {
  const url = 'https://api.github.com' + path
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': UA }
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout * 1000) })
    if (res.status === 404) return [null, '404 仓库不存在或无权限']
    if (res.status === 403 || res.status === 429) {
      const reset = res.headers.get('x-ratelimit-reset')
      // The header is a unix timestamp; rendering it in local time is what makes
      // "wait until 17:30" actionable rather than "wait until 1759320600".
      const when = reset ? hhmm(new Date(Number(reset) * 1000)) : ''
      return [null, `限流/拒绝(${res.status})，额度重置 ${when}`]
    }
    if (!res.ok) return [null, `HTTP ${res.status}`]
    return [await res.json(), null]
  } catch (exc) {
    return [null, `${exc.name || 'Error'}: ${exc.message || exc}`]
  }
}

/** Run git. Returns [stdout, code, stderr]. */
function git(args, { cwd = undefined, timeout = 40 } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeout * 1000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (r.error) {
    // spawnSync reports its own timeout by killing the child and setting `error`;
    // callers distinguish that from git's own exit codes, so map it to 124 (the
    // shell's "timed out") rather than the -1 spawnSync leaves behind.
    if (r.error.code === 'ETIMEDOUT') return ['', 124, '超时']
    return ['', 1, `${r.error.code || 'Error'}: ${r.error.message}`]
  }
  return [(r.stdout || '').trim(), r.status ?? 1, (r.stderr || '').trim()]
}

function remoteUrl(slug) {
  return TOKEN
    ? `https://x-access-token:${TOKEN}@github.com/${slug}.git`
    : `https://github.com/${slug}.git`
}

/** Arrays of ints, compared the way Python compares lists (a prefix is smaller). */
function cmpVersion(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

function versionKey(v) {
  return String(v)
    .split(/[.\-+]/)
    .slice(0, 4)
    .map((x) => (/^\d+$/.test(x) ? Number.parseInt(x, 10) : 0))
}

// ── probes ───────────────────────────────────────────────────────────────
/** ls-remote for the upstream sha, then compare each local clone's HEAD. */
function probeGit(slug, branch, localPaths) {
  // `branch` may be empty when the caller does not know it. Asking for
  // "refs/heads/None" is what a naive template string produces, and git answers
  // with an empty error — five projects reported "ls-remote 失败: " and nothing
  // else. Resolve the default branch from the remote instead of guessing.
  let br = branch
  if (!br) {
    const [headOut, headRc] = git(['ls-remote', '--symref', remoteUrl(slug), 'HEAD'])
    if (headRc === 0 && headOut) {
      const m = /refs\/heads\/(\S+)/.exec(headOut)
      if (m) br = m[1]
    }
  }
  if (!br) return { ok: false, error: '无法确定默认分支' }

  const [out, rc, err] = git(['ls-remote', '--heads', remoteUrl(slug), `refs/heads/${br}`])
  if (rc !== 0 || !out) {
    const msg = TOKEN ? err.split(TOKEN).join('***') : err
    return { ok: false, error: `ls-remote 失败: ${msg.slice(0, 200)}` }
  }
  const remoteSha = out.split(/\s+/)[0].slice(0, 7)

  const clones = []
  for (const path of localPaths || []) {
    if (!isdir(path)) {
      clones.push({ path, missing: true })
      continue
    }
    const [head, rc2] = git(['rev-parse', '--short=7', 'HEAD'], { cwd: path })
    const [dirty] = git(['status', '--porcelain'], { cwd: path })
    const [behind, rc3] = git(['rev-list', '--count', `${head}..origin/${br}`], {
      cwd: path,
      timeout: 25,
    })
    clones.push({
      path,
      head: rc2 === 0 ? head : null,
      dirty: dirty.split('\n').filter((l) => l.trim()).length,
      behind: rc3 === 0 && /^\d+$/.test(behind) ? Number.parseInt(behind, 10) : null,
    })
  }
  return { ok: true, remote_sha: remoteSha, clones }
}

/**
 * Upstream's newest commit. `branch` null means the repository default.
 *
 * Not hardcoded to "main": OmniParser's default branch is master, and asking
 * `?sha=main` answers 404 — which reads as "repository does not exist" when it
 * was only a wrong guess at the branch name.
 */
async function probeApi(slug, branch = null) {
  let br = branch
  if (!br) {
    const [info, err] = await api(`/repos/${slug}`)
    if (err) return { ok: false, error: err }
    br = info.default_branch || 'main'
  }
  let [data, err] = await api(`/repos/${slug}/commits?sha=${br}&per_page=1`)
  if (err) {
    // A wrong branch name falls back to the default branch instead of being
    // reported as a failure.
    if (err.includes('404')) {
      const [info, err2] = await api(`/repos/${slug}`)
      if (!err2) {
        const fallback = info.default_branch || 'main'
        if (fallback !== br) {
          ;[data, err] = await api(`/repos/${slug}/commits?sha=${fallback}&per_page=1`)
          br = fallback
        }
      }
    }
    if (err) return { ok: false, error: err }
  }
  if (!data || !data.length) return { ok: false, error: '无 commit 数据' }
  const c = data[0]
  const lines = String(c.commit.message || '').split('\n')
  return {
    ok: true,
    remote_sha: String(c.sha).slice(0, 7),
    branch: br,
    date: c.commit.committer.date,
    message: (lines[0] || '').slice(0, 70),
  }
}

/**
 * `owner/repo` a published npm package declares, or ''.
 *
 * The registry copy carries the same `repository` field the installed manifest
 * does, so this works even when the plugin is in node_modules with no manifest to
 * read. Needed because a package's `description` says what the package IS ("a
 * context-compression plugin"), never what a release CHANGED — the release feed is
 * the only place that exists.
 */
async function npmRepoSlug(pkg, version = '') {
  const url = `https://registry.npmjs.org/${pkg.replace('/', '%2F')}`
  let data
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return ''
    data = await res.json()
  } catch {
    return ''
  }
  const versions = data.versions || {}
  const tags = data['dist-tags'] || {}
  const info = versions[version] || versions[tags.latest || ''] || {}
  const repo = info.repository
  const raw = repo && typeof repo === 'object' ? repo.url || '' : String(repo || '')
  const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(raw.trim())
  return m ? m[1] : ''
}

/**
 * One short line saying what changed, for the row's hint.
 *
 * Release notes follow a shape: a section heading (`### Added / 新增`), a blank
 * line, then the actual bullet. Picking "### Added / 新增" tells the reader
 * nothing they did not already know from the version number; the bullet
 * underneath is the content. So headings and boilerplate are skipped, and the
 * first real bullet is cut to the row's 20-character budget at a clause boundary.
 */
function summarizeRelease(body) {
  const text = String(body || '').replace(/\r/g, '')
  const lines = text.split('\n').map((ln) => ln.replace(/\s+$/, ''))

  const isHeading = (raw) => {
    const s = raw.trim()
    if (s.startsWith('#')) return true
    // "Added / 新增" and similar bilingual section titles, with no sentence
    // punctuation, are headings even without a leading '#'.
    //
    // The CJK alternatives need their own test: JavaScript's `\b` only breaks
    // between an ASCII word character and a non-word one, so `\b` after 新增 never
    // matches — CJK glyphs are non-word to JS. Python's `\w` counted them, which is
    // why this reads differently here.
    const ascii = /^(added|changed|fixed|removed|deprecated|security)\b/i.test(s)
    const cjk = /^(新增|修复|变更|移除|改进)/.test(s)
    return (ascii || cjk) && !/[。．.!?]/.test(s)
  }

  const clean = (raw) => {
    let s = raw
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    s = s.replace(/https?:\/\/\S+/g, '')
    s = s.replace(/\s+by\s+@[\w-]+/gi, '')
    s = s.replace(/[`*_>]/g, '')
    s = s.replace(/^[\-*\s]+/, '')
    s = s.replace(/^\(?\d+\)?\s*/, '')
    // "[PR]", "[pr]", "(PR #12)" are provenance tags, not content — a summary that
    // opens with one spends its budget saying where the change came from instead
    // of what it does.
    s = s.replace(/^[\[(（]\s*(PR|Pull Request|Issue|FIX)\s*[#\d]*\s*[\])）]\s*[:\-]?\s*/i, '')
    // Conventional-commit prefixes read as tooling, not prose.
    s = s.replace(/^(feat|fix|chore|refactor|docs|test|perf|build|ci|style)(\([^)]*\))?!?\s*:\s*/i, '')
    // A dangling "#123" at the start is a reference, not a subject.
    s = s.replace(/^[#＃]\d+\s*[:\-]?\s*/, '')
    s = s.replace(/\s*\(#\d+\)/g, '')
    s = s.replace(/\s+/g, ' ')
    return s.trim()
  }

  const hasCjk = (t) => /[\u4e00-\u9fff]/.test(t)

  // Lines that describe HOW TO GET the software, not WHAT CHANGED in it. A release
  // page usually opens with the install command; picking that line tells the
  // operator nothing they did not already know from the version.
  // A bare platform name on its own line introduces a per-OS install block
  // ("Windows:", "macOS:", "Linux:"). Reading it as the summary says the release
  // was about "Windows", which is not a change at all.
  const platformLabel = /^(windows|macos|linux|darwin|wsl|freebsd|android)\s*(:|$)/i

  const INSTALL_NOISE =
    /(to install|to upgrade|install (bun|it|with)|curl -|npm i(nstall)?\s|bash\s|powershell -|brew (install|upgrade)|scoop |winget |^thanks?\s|^thanks? to|^thanks to \d+|^bun upgrade|^read .*release notes|release notes on|^full changelog|^\s*#\s*$|^```)/i

  // A bullet whose whole text is one handle. Must match ASCII identifier
  // characters only: a laxer pattern would treat "飞书新增会话目录隔离" as a handle
  // and drop every Chinese summary.
  const HANDLE_ONLY = /^@[A-Za-z0-9_.-]+$/

  const bullets = []
  for (const ln of lines) {
    const s = ln.trim()
    if (!s) continue
    if (isHeading(s)) continue
    if (INSTALL_NOISE.test(s) || platformLabel.test(s)) continue
    // A bullet starts with '-', '*', or is a numbered item; a continuation line of
    // the previous bullet is not a candidate.
    if (!/^[\-*]|^\d+[.)]/.test(s)) continue
    const c = clean(s)
    if (c.length < 4) continue
    if (HANDLE_ONLY.test(c)) continue
    // An English translation line usually follows the Chinese one and repeats it;
    // skip lines that are plainly the same bullet in English.
    if (!hasCjk(c) && bullets.length && hasCjk(bullets[bullets.length - 1])) continue
    bullets.push(c)
  }

  let picked = ''
  if (bullets.length) picked = bullets.find((b) => hasCjk(b)) || bullets[0]
  if (!picked) {
    // No bullets at all: fall back to the first prose line that is not a heading,
    // which is what a hand-written note looks like.
    for (const ln of lines) {
      const s = ln.trim()
      if (!s || isHeading(s) || INSTALL_NOISE.test(s) || platformLabel.test(s)) continue
      const c = clean(s)
      if (c.length >= 6 && !HANDLE_ONLY.test(c)) {
        picked = c
        break
      }
    }
  }

  if (!picked) return ''

  // Budget: 20 CJK characters, 30 latin characters. One CJK glyph carries roughly
  // twice the information of one latin character, so the same slot fits a shorter
  // Chinese phrase and a longer English one. Cutting both at 20 made every English
  // summary end mid-phrase ("Preserve rotated" — subject lost).
  const cjk = hasCjk(picked)
  const limit = cjk ? 20 : 30

  if (picked.length > limit) {
    const windowText = picked.slice(0, limit + 10)
    let cut = -1
    // Prefer punctuation that ends a clause; a space is the last resort and only
    // when it leaves a substantial phrase behind.
    const seps = [
      ['。', 5], ['，', 7], ['；', 7], ['、', 7], ['：', 9],
      ['!', 9], ['.', 9], [',', 12], [';', 12], [':', 12],
      ['—', 16], [' ', 22],
    ]
    for (const [sep, floor] of seps) {
      const pos = windowText.lastIndexOf(sep, limit)
      if (pos > floor) {
        cut = pos
        break
      }
    }
    picked = cut > 0 ? windowText.slice(0, cut) : picked.slice(0, limit)
    // A trailing connective left by the cut reads broken; drop it.
    picked = picked.replace(/[，,、；;：:\s]+(支持|并|和|与|及|或)?\s*$/, '')
  }

  return picked.replace(/^[ ，,。.；;：:\-—]+|[ ，,。.；;：:\-—]+$/g, '')
}

/**
 * Newest released version of a repository, for a plugin installed from it.
 *
 * A plugin in `node_modules` has no `.git`, so `git ls-remote` cannot help; and
 * when the manifest's repository has been renamed or deleted, its URL fails too.
 * The releases/tags API answers for the repository that still exists, which is the
 * thing the operator actually wants to compare against.
 */
async function probeTags(slug) {
  const [data, err] = await api(`/repos/${slug}/releases/latest`)
  if (!err && data) {
    const tag = String(data.tag_name || '').trim()
    if (tag) {
      return {
        ok: true,
        latest: tag.replace(/^[vV]+/, ''),
        tag,
        date: String(data.published_at || '').slice(0, 10),
        summary: summarizeRelease(data.body || ''),
      }
    }
  }

  // No releases: fall back to the tag list, which is where a plugin that only tags
  // its commits keeps its versions.
  const [tags, err2] = await api(`/repos/${slug}/tags?per_page=30`)
  if (err2) return { ok: false, error: err2 }
  if (!tags || !tags.length) return { ok: true, latest: null, error: '仓库没有 release 也没有 tag' }

  let best = null
  for (const t of tags) {
    const name = String(t.name || '').trim().replace(/^[vV]+/, '')
    if (!name || !/^\d/.test(name)) continue
    if (best === null || cmpVersion(versionKey(name), versionKey(best)) > 0) best = name
  }
  if (best === null) return { ok: true, latest: null, error: 'tag 都不是版本号' }
  return { ok: true, latest: best, tag: `v${best}` }
}

/**
 * Latest release tag for a repository, for hand-downloaded binaries.
 *
 * These have no `.git` to compare against and are not in any package registry, so
 * the release feed is the only place their upstream version exists. A repo with no
 * releases answers 200 with an empty list; that is reported as "no release to
 * compare against", not as a failed check.
 */
async function probeRelease(slug) {
  const [data, err] = await api(`/repos/${slug}/releases/latest`)
  if (err) return { ok: false, error: err }
  if (!data) return { ok: true, latest: null, gone: false, error: '上游没有发布 release' }
  const tag = String(data.tag_name || '').trim()
  if (!tag) return { ok: true, latest: null, gone: false, error: 'release 没有 tag' }
  return {
    ok: true,
    latest: tag.replace(/^[vV]+/, ''),
    tag,
    date: String(data.published_at || '').slice(0, 10),
    message: String(data.name || '').slice(0, 80),
    summary: summarizeRelease(data.body || ''),
  }
}

/** Parse "3.12.13" into a comparable triple; unknown parts become 0. */
function parsePyver(text) {
  const out = []
  for (const part of String(text).split('.').slice(0, 3)) {
    const digits = part.replace(/\D/g, '')
    out.push(digits ? Number.parseInt(digits, 10) : 0)
  }
  while (out.length < 3) out.push(0)
  return out
}

/**
 * Does `version` meet a simple PEP 440 specifier?
 *
 * Only the forms PyPI packages actually use are handled: `>=`, `>`, `<=`, `<`,
 * `==`, `!=`, and `~=`. A compound spec separated by commas must have every clause
 * satisfied. Anything unrecognised is treated as "no constraint" — guessing wrong
 * here would hide a real update.
 */
function satisfies(version, spec) {
  if (!spec || !String(spec).trim()) return true
  const have = parsePyver(version)
  for (const clauseRaw of String(spec).split(',')) {
    const clause = clauseRaw.trim()
    if (!clause) continue
    const m = /^(>=|<=|==|!=|~=|>|<)\s*([\d][\w.]*)/.exec(clause)
    if (!m) continue
    const op = m[1]
    const wantRaw = m[2]
    const want = parsePyver(wantRaw)
    const cmp = cmpVersion(have, want)
    if (op === '>=' && !(cmp >= 0)) return false
    if (op === '>' && !(cmp > 0)) return false
    if (op === '<=' && !(cmp <= 0)) return false
    if (op === '<' && !(cmp < 0)) return false
    if (op === '==') {
      // `==3.12.*` style is common; compare the stated prefix only.
      const n = wantRaw.split('.').filter((p) => p && p !== '*').length
      if (cmpVersion(have.slice(0, n), want.slice(0, n)) !== 0) return false
    }
    if (op === '!=') {
      // `!=3.12` excludes every 3.12.x, so compare on the stated prefix rather than
      // the padded triple.
      const n = wantRaw.split('.').filter((p) => p && p !== '*').length
      if (cmpVersion(have.slice(0, n), want.slice(0, n)) === 0) return false
    }
    if (op === '~=') {
      // Compatible release: >= want, and same leading components minus one.
      if (!(cmp >= 0)) return false
      const n = Math.max(1, wantRaw.split('.').length - 1)
      if (cmpVersion(have.slice(0, n), want.slice(0, n)) !== 0) return false
    }
  }
  return true
}

/**
 * The interpreter a `uv tool` install would use here.
 *
 * Read from the tool environment rather than this process: the checker runs under
 * whatever runtime launched it, while `uv tool upgrade` installs into its own
 * managed interpreter. Those can differ, and the constraint that matters is the
 * one the installer will apply.
 */
function installedPython() {
  const roaming = appdata()
  const candidates = []
  const tools = join(roaming, 'uv', 'tools')
  if (isdir(tools)) {
    for (const entry of readdirSync(tools).sort()) {
      const cfg = join(tools, entry, 'pyvenv.cfg')
      if (isfile(cfg)) candidates.push(cfg)
    }
  }
  // Fall back to uv's own managed interpreters when no tool environment exists.
  const uvPy = join(roaming, 'uv', 'python')
  if (isdir(uvPy)) {
    for (const entry of readdirSync(uvPy).sort()) {
      const p = join(uvPy, entry, 'python.exe')
      if (isfile(p)) candidates.push(p)
    }
  }
  for (const cfg of candidates) {
    try {
      for (const line of readFileSync(cfg, 'utf8').split('\n')) {
        if (!line.trim().startsWith('version_info')) continue
        const eq = line.indexOf('=')
        const val = eq >= 0 ? line.slice(eq + 1).trim() : ''
        if (val) return val
      }
    } catch {
      /* unreadable: try the next candidate */
    }
  }
  return process.versions.python || `node ${process.versions.node}`
}

/**
 * Latest version on PyPI, for packages installed by `uv tool` / `pipx`.
 *
 * Probing those with npm answers 404 and the row then claims "removed upstream",
 * which is false — the package was never on npm. The JSON API returns 404 for a
 * name it does not have, the same distinction npm makes via its exit code: 404
 * means "not published there", not "check failed".
 *
 * The newest release is only an update if THIS machine can install it. PyPI
 * publishes `requires_python` per file, and a package that jumped to a newer
 * interpreter keeps its old release installable — reporting the new one as
 * available made the Update button look broken, because `uv tool upgrade`
 * correctly answered "nothing to upgrade" and nothing changed.
 */
async function probePypi(name) {
  const url = `https://pypi.org/pypi/${name}/json`
  let data
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(25000),
    })
    if (res.status === 404) {
      return { ok: true, latest: null, gone: true, error: 'PyPI 上已不存在' }
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    data = await res.json()
  } catch (exc) {
    return { ok: false, error: `${exc.name || 'Error'}: ${exc.message || exc}` }
  }

  const info = data.info || {}
  const latest = String(info.version || '').trim()
  if (!latest) return { ok: false, error: 'PyPI 响应里没有 version' }

  const localPy = installedPython()
  const releases = data.releases || {}

  const installable = (ver) => {
    const files = releases[ver] || []
    const usable = files.filter((f) => !f.yanked)
    if (!usable.length) return false
    // A release with no requires_python has no interpreter constraint.
    return usable.some((f) => satisfies(localPy, f.requires_python || ''))
  }

  if (installable(latest)) {
    const out = { ok: true, latest }
    // PyPI exposes the project's repository; the release feed there says what
    // changed, which the PyPI `summary` field does not.
    const urls = info.project_urls || {}
    const slug = urls.Repository || urls.Source || String(info.home_page || '')
    const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(String(slug).trim())
    if (m) {
      const rel = await probeTags(m[1])
      if (rel.ok) {
        out.summary = rel.summary || ''
        out.tag = rel.tag || ''
      }
    }
    return out
  }

  // The newest release exists but this interpreter cannot install it. Report the
  // newest one it CAN install, so the row stops promising an upgrade that the
  // installer will refuse.
  const wantPy = ((releases[latest] || [{}])[0] || {}).requires_python || ''
  const candidates = []
  for (const ver of Object.keys(releases)) {
    if (!/^\d+(\.\d+)*$/.test(ver)) continue // skip pre-releases and odd tags
    if (installable(ver)) candidates.push(ver)
  }
  candidates.sort((a, b) => cmpVersion(versionKey(a), versionKey(b)))
  const best = candidates.length ? candidates[candidates.length - 1] : null
  return {
    ok: true,
    latest: best || latest,
    blocked_by_python: true,
    wanted: latest,
    requires_python: wantPy,
    local_python: localPy,
    error:
      `最新 ${latest} 需要 Python ${wantPy}，本机 ${localPy}` +
      (best ? `；可安装的最高版本是 ${best}` : ''),
  }
}

/**
 * Newest version of an npm package.
 *
 * This asks the registry directly instead of shelling out to `npm view`. The
 * answer is the same one `npm view <pkg> version` gives — the `latest` dist-tag —
 * but it removes npm from the list of things a fresh machine must have installed,
 * which is the whole reason this file exists in JavaScript rather than Python.
 *
 * The failure distinction is the same one npm's exit code carried:
 *   200 with a version -> compare versions
 *   404               -> not published (delisted / private), i.e. "removed
 *                        upstream", not "check failed"
 *   anything else     -> a real failure
 */
async function probeNpm(name) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`
  let data
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    })
    if (res.status === 404) {
      return { ok: true, latest: null, gone: true, error: 'npm 上已不存在（404）' }
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    data = await res.json()
  } catch (exc) {
    return { ok: false, error: `${exc.name || 'Error'}: ${exc.message || exc}` }
  }

  const tags = data['dist-tags'] || {}
  const ver = String(tags.latest || '').trim()
  if (!ver) return { ok: false, error: 'registry 响应里没有 latest' }

  // The registry copy names the repository; the release feed is where "what
  // changed in this version" lives. A package's `description` only says what the
  // package is, which reads identical every release and answers a different
  // question.
  const out = { ok: true, latest: ver }
  const slug = await npmRepoSlug(name, ver)
  if (slug) {
    const rel = await probeTags(slug)
    if (rel.ok) {
      out.summary = rel.summary || ''
      out.tag = rel.tag || ''
    }
  }
  return out
}

// ── main flow ────────────────────────────────────────────────────────────
/** One row of the report. */
function makeRow({ name, kind, status = '', detail = '', slug = '', clones = [], versions = '', summary = '' }) {
  return {
    name,
    kind,
    status,
    detail,
    slug,
    clones,
    versions,
    // A one-line description of what the new version changed, kept separate from
    // `detail` so the row can show it in its own slot instead of lengthening the
    // status sentence.
    summary,
  }
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = next
      next += 1
      if (idx >= items.length) return
      results[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return results
}

function probeKey(proj, pr) {
  const how = pr.type
  if (how === 'npm' || how === 'pypi') return JSON.stringify([how, proj.npm_name || proj.name])
  if (how === 'release' || how === 'tags') return JSON.stringify([how, proj.slug])
  return JSON.stringify([how, proj.slug, pr.branch ?? null])
}

async function runProbe(proj, pr) {
  const how = pr.type
  if (how === 'git') return probeGit(proj.slug, pr.branch || 'main', proj.paths || [])
  if (how === 'api') return probeApi(proj.slug, pr.branch ?? null)
  if (how === 'pypi') return probePypi(proj.npm_name || proj.name)
  if (how === 'release') return probeRelease(proj.slug || '')
  if (how === 'tags') return probeTags(proj.slug || '')
  if (how === 'npm') return probeNpm(proj.npm_name || proj.name)
  return null
}

async function checkAll(projects, state) {
  const rows = []
  if (!state.seen) state.seen = {}
  const last = state.seen

  // Live progress for the Settings page. This step is ~85% of a scan's wall clock
  // (many network round-trips against one 2-second disk walk), and a page can only
  // report what it can read — so each finished project is written out as it
  // completes, not at the end. Best-effort: a failed write must never break the
  // check itself.
  const progPath = join(BASE, 'scan_progress.json')
  const total = (projects.projects || []).length

  const emit = (done, name) => {
    // Overwritten from scratch on every run (the first call is emit(0, '')). Left
    // on disk afterwards on purpose: when a check dies partway, this is the only
    // record of how far it got. `at` distinguishes a finished copy from one that
    // stopped mid-run.
    try {
      const tmp = `${progPath}.tmp`
      writeFileSync(
        tmp,
        JSON.stringify({ done, total, current: name, at: stampShortSeconds() }),
        'utf8',
      )
      renameSync(tmp, progPath)
    } catch {
      /* progress is advisory */
    }
  }

  emit(0, '')

  // Probe every project concurrently, then consume the results in order. The
  // probes are almost entirely network round-trips, so running them serially made
  // the check as slow as the sum of its latencies. The reporting loop below stays
  // sequential: it decides status wording and emits progress, and keeping it
  // unchanged means the concurrent path cannot alter any message.
  const prefetched = new Map()

  const prefetch = async (proj) => {
    const out = []
    for (const pr of proj.probe || []) {
      const key = probeKey(proj, pr)
      let val
      try {
        val = await runProbe(proj, pr)
      } catch (exc) {
        val = { ok: false, error: String(exc && exc.message ? exc.message : exc) }
      }
      if (!val) continue
      out.push([key, val])
      // One attempt per project is enough: the loop below stops at the first
      // successful probe, so later probes for the same project would only be
      // fetched to be discarded.
      if (val.ok) break
    }
    return out
  }

  const targets = (projects.projects || []).filter((p) => (p.probe || []).length)
  if (targets.length) {
    const done = await mapPool(targets, PROBE_WORKERS, prefetch)
    for (const pairs of done) {
      for (const [key, val] of pairs) prefetched.set(key, val)
    }
  }

  let idx = 0
  for (const proj of projects.projects || []) {
    idx += 1
    const r = makeRow({
      name: proj.name,
      kind: proj.kind || '?',
      slug: proj.slug || '',
      versions: proj.local_version || '',
    })
    const probes = proj.probe || []
    if (!probes.length) {
      r.status = '无上游'
      // No fallback text: the registry always sets `note`, sometimes to '', and an
      // empty note means "this row has nothing to add". Falling back to a default
      // would replace that silence with a sentence the operator never wrote.
      r.detail = proj.note || ''
      rows.push(r)
      emit(idx, proj.name)
      continue
    }

    let got = null
    const errors = []
    for (const pr of probes) {
      const how = pr.type
      const cached = prefetched.get(probeKey(proj, pr))
      if (how === 'git') {
        got = cached !== undefined ? cached : probeGit(proj.slug, pr.branch || 'main', proj.paths || [])
      } else if (how === 'api') {
        got = cached !== undefined ? cached : await probeApi(proj.slug, pr.branch ?? null)
        if (got.ok) {
          // api can only give the upstream side; the local HEAD still needs git.
          for (const path of proj.paths || []) {
            if (!isdir(path)) continue
            const [head, rc] = git(['rev-parse', '--short=7', 'HEAD'], { cwd: path })
            const [dirty] = git(['status', '--porcelain'], { cwd: path })
            r.clones.push({
              path,
              head: rc === 0 ? head : null,
              dirty: dirty.split('\n').filter((l) => l.trim()).length,
              behind: null,
            })
          }
        }
      } else if (how === 'tags') {
        got = cached !== undefined ? cached : await probeTags(proj.slug || '')
        const lv = proj.local_version || ''
        const tag = got.tag || ''
        if (got.ok && got.latest) {
          const up = got.latest
          if (lv && cmpVersion(versionKey(up), versionKey(lv)) > 0) {
            r.status = '有更新'
            r.detail = `本地 ${lv} → 上游 ${tag}`
            // Only when there is something to install. The summary describes the
            // newest upstream release whether or not you are behind it, so
            // attaching it to an up-to-date row showed notes for a version you
            // already have.
            r.summary = got.summary || ''
          } else if (lv && cmpVersion(versionKey(lv), versionKey(up)) > 0) {
            // The local copy is AHEAD of the repository's newest tag. That happens
            // with a hand-maintained fork installed by path: the repo's releases
            // never kept up with it. Writing "本地 1.4.4 = 上游 v1.1.83" claimed the
            // two were equal, which is arithmetic nobody can act on.
            r.status = '本地领先'
            r.detail = `本地 ${lv} 高于上游最新 ${tag}（本地是自行维护的版本）`
          } else if (lv) {
            r.status = '最新'
            r.detail = `本地 ${lv} = 上游 ${tag}`
          } else {
            r.status = '最新'
            r.detail = `上游 ${tag}`
          }
          if (got.date) r.detail += ` ｜ ${got.date}`
          if (proj.note) r.detail += ` ｜ ${proj.note}`
          r.versions = `${lv || '?'} → ${tag}`
        } else if (got.ok) {
          r.status = '无上游'
          r.detail = got.error || '仓库没有可比对的版本'
        } else {
          errors.push(got.error || 'tag 查询失败')
        }
        break
      } else if (how === 'release') {
        got = cached !== undefined ? cached : await probeRelease(proj.slug || '')
        const lv = proj.local_version || ''
        const tag = got.tag || got.latest || ''
        if (got.ok && got.latest) {
          const up = got.latest
          if (lv && cmpVersion(versionKey(up), versionKey(lv)) > 0) {
            r.status = '有更新'
            r.detail = `本地 ${lv} → 上游 ${tag}`
          } else if (lv) {
            r.status = '最新'
            r.detail = `本地 ${lv} = 上游 ${tag}`
          } else {
            r.status = '最新'
            r.detail = `上游 ${tag}`
          }
          if (got.date) r.detail += ` ｜ ${got.date}`
          if (proj.note) r.detail += ` ｜ ${proj.note}`
          r.versions = `${lv || '?'} → ${tag}`
        } else if (got.ok) {
          r.status = '无上游'
          r.detail = got.error || '上游没有可比对的 release'
        } else {
          errors.push(got.error || 'release 查询失败')
        }
        break
      } else if (how === 'npm' || how === 'pypi') {
        if (cached !== undefined) {
          got = cached
        } else {
          const n = proj.npm_name || proj.name
          got = how === 'pypi' ? await probePypi(n) : await probeNpm(n)
        }
        const registry = how === 'pypi' ? 'PyPI' : 'npm'
        if (got.ok) {
          const lv = proj.local_version || ''
          if (got.gone) {
            r.status = '上游已下架'
            r.detail = `本地仍有 ${lv || '?'}，${registry} 上已取不到`
            if (proj.note) r.detail += ` ｜ ${proj.note}`
          } else if (got.blocked_by_python) {
            // There IS a newer release, but this machine's interpreter cannot
            // install it. Saying "有更新" here is what made the Update button look
            // broken: the installer correctly answered "nothing to upgrade" and
            // nothing changed.
            r.status = '受 Python 版本限制'
            r.detail =
              `上游 ${got.wanted} 需要 Python ${got.requires_python}，` +
              `本机 ${got.local_python}；当前 ${lv || '?'} 已是可安装的最高版本`
            if (proj.note) r.detail += ` ｜ ${proj.note}`
            r.versions = `${lv || '?'}（上限）`
          } else if (lv && cmpVersion(versionKey(got.latest), versionKey(lv)) > 0) {
            r.status = '有更新'
            r.detail = `本地 ${lv} → 上游 ${got.latest}`
            // Same rule as the tags lane: a summary belongs to an update that is
            // actually pending, nothing else.
            r.summary = got.summary || ''
            if (proj.note) r.detail += ` ｜ ${proj.note}`
          } else {
            r.status = '最新'
            r.detail = `本地 ${lv || '?'} = 上游 ${got.latest}`
            if (proj.note) r.detail += ` ｜ ${proj.note}`
          }
          r.versions = `${lv || '?'} → ${got.latest || '（无）'}`
        } else {
          errors.push(got.error || '')
        }
        break
      }
      if (got && got.ok) break
      if (got) errors.push(got.error || '')
    }

    if (got === null || !got.ok) {
      r.status = '检查失败'
      r.detail = errors.filter(Boolean).join('; ').slice(0, 180)
      rows.push(r)
      emit(idx, proj.name)
      continue
    }

    if (['npm', 'pypi', 'release', 'tags'].includes(r.kind)) {
      rows.push(r)
      emit(idx, proj.name)
      continue
    }

    if (Array.isArray(got.clones) && got.clones.length) r.clones = got.clones
    const remoteSha = got.remote_sha

    // Snapshot-like rows (no .git): there is no local HEAD to compare, so the only
    // available comparison is "upstream's newest commit date" against "the local
    // directory's last-modified time". That still cannot prove how far behind it
    // is, so the wording is "上游有新提交" and never "最新" — saying "up to date"
    // about a directory someone edited would be a lie.
    if (r.kind === 'snapshot') {
      const upDate = String(got.date || '').slice(0, 10)
      let localMtime = null
      for (const path of proj.paths || []) {
        if (!isdir(path)) continue
        try {
          const mtimes = readdirSync(path).map((f) => statSync(join(path, f)).mtimeMs)
          localMtime = mtimes.length ? Math.max(...mtimes) : statSync(path).mtimeMs
          break
        } catch {
          /* unreadable: try the next path */
        }
      }
      const localDay = localMtime ? stampDate(new Date(localMtime)) : '?'
      const newer = Boolean(upDate && localMtime && upDate > localDay)
      r.status = newer ? '上游有新版' : '未见新版'
      const bits = [`上游 ${upDate}`, `本地 ${localDay}`]
      if (proj.local_version) bits.unshift(`本地版本 ${proj.local_version}`)
      if (proj.note) bits.push(proj.note)
      r.detail = bits.join(' ｜ ')
      rows.push(r)
      emit(idx, proj.name)
      continue
    }

    const shas = new Set(r.clones.map((c) => c.head).filter(Boolean))
    if (!shas.size) {
      r.status = '检查失败'
      r.detail = '本地没有可读的 git HEAD'
    } else if (shas.has(remoteSha)) {
      r.status = '最新'
    } else {
      const behind = r.clones.map((c) => c.behind).filter(Boolean)
      r.status = '有更新'
      r.detail = behind.length
        ? `落后 ${Math.max(...behind)} 个提交`
        : `上游 ${remoteSha} ≠ 本地 ${[...shas].sort().join('/')}`
    }
    if (got.message) {
      r.detail = (r.detail ? `${r.detail} ｜ ` : '') + `最新提交: ${got.message}`
    }
    if (got.date) {
      r.detail = (r.detail ? `${r.detail} ｜ ` : '') + String(got.date).slice(0, 10)
    }
    last[proj.name] = remoteSha
    rows.push(r)
    emit(idx, proj.name)
  }

  return rows
}

function stampShortSeconds(d = new Date()) {
  return stampShort(d).length === 16 ? `${stampShort(d)}:00` : stampShort(d)
}

function stampDate(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function render(rows, _projects) {
  const order = {
    有更新: 0,
    上游已下架: 1,
    上游有新版: 2,
    检查失败: 3,
    无上游: 4,
    未见新版: 5,
    最新: 6,
  }
  const sorted = rows.slice().sort((a, b) => {
    const x = order[a.status] ?? 9
    const y = order[b.status] ?? 9
    if (x !== y) return x - y
    const an = a.name.toLowerCase()
    const bn = b.name.toLowerCase()
    return an < bn ? -1 : an > bn ? 1 : 0
  })
  const now = stampShort()

  const nUp = sorted.filter((r) => r.status === '有更新').length
  const nNew = sorted.filter((r) => r.status === '上游有新版').length
  const nGone = sorted.filter((r) => r.status === '上游已下架').length
  const nOk = sorted.filter((r) => r.status === '最新' || r.status === '未见新版').length
  const nErr = sorted.filter((r) => r.status === '检查失败').length
  const nNa = sorted.filter((r) => r.status === '无上游').length

  const out = [
    '# GitHub 项目更新报告',
    '',
    `生成时间：${now}　｜　共 **${sorted.length}** 个项目`,
    `有更新 **${nUp}**　上游有新提交 ${nNew}　已下架 ${nGone}　已最新 ${nOk}　失败 ${nErr}　无上游 ${nNa}`,
    '',
  ]

  if (nUp) {
    out.push('## 可以 pull 的（有 .git，落后上游）', '')
    for (const r of sorted) {
      if (r.status !== '有更新') continue
      out.push(`### ${r.name}`)
      if (r.slug) out.push(`https://github.com/${r.slug}`)
      if (r.detail) out.push(`> ${r.detail}`)
      for (const c of r.clones) {
        const flag = c.dirty ? ' ⚠ 有未提交改动' : ''
        const miss = c.missing ? ' （目录不存在）' : ''
        out.push(`- \`${c.path}\`${miss}${flag}  HEAD ${c.head || '?'}`)
      }
      out.push('')
    }
  }

  if (nNew) {
    out.push('## 上游有新提交，但本地不是 git（无法直接 pull）', '')
    for (const r of sorted) {
      if (r.status !== '上游有新版') continue
      out.push(`- **${r.name}** — ${r.detail}`)
    }
    out.push('')
  }

  out.push(
    '## 全部项目',
    '',
    '| 项目 | 类型 | 状态 | 说明 | 更新内容 |',
    '|---|---|---|---|---|',
  )
  const MARK = {
    有更新: '🔴',
    最新: '✅',
    上游有新版: '🟡',
    上游已下架: '⛔',
    未见新版: '✅',
    检查失败: '⚠️',
    无上游: '—',
  }
  for (const r of sorted) {
    const mark = MARK[r.status] || ''
    // The summary is its own column: it describes the NEW version, which is
    // unrelated to "what is installed vs what is upstream" in the detail.
    const summary = String(r.summary || '').split('|').join('｜')
    out.push(`| ${r.name} | ${r.kind} | ${mark} ${r.status} | ${r.detail.slice(0, 70)} | ${summary} |`)
  }

  out.push(
    '',
    '---',
    '',
    `token: ${TOKEN ? '已用（额度 5000/h）' : '未用（匿名 60/h）'}　｜　探测方式按项目降级：git → api → npm`,
    '',
  )
  return out.join('\n')
}

/**
 * Translate inventory.json into the shape checkAll() expects.
 *
 * Two files used to describe the same projects: projects.json (what the checker
 * read) and inventory.json (what the page showed). They drifted — the checker kept
 * probing a project after its directory was deleted and returned exit 1 every run
 * because of it, while the page had long stopped showing that row. One registry,
 * read by both, is the only arrangement where "the page says X" and "the check says
 * X" cannot disagree.
 */
function registryFromInventory() {
  const inv = loadJson(join(BASE, 'inventory.json'), null)
  if (!inv) return { projects: [] }

  const out = []
  for (const p of inv.projects || []) {
    const entry = {
      name: p.name,
      kind: p.kind || 'git',
      slug: p.slug || '',
      paths: [p.path].filter(Boolean),
      local_version: p.version || null,
      note: p.note || '',
    }
    // A muted project is skipped by emptying its probe list, not by dropping the
    // row. Dropping it would make the page and the checker disagree about what
    // exists — the exact drift this function was written to end — and it would also
    // spend nothing here but hide the fact that it was deliberately parked. `muted`
    // survives in inventory.json so the page can say why.
    if (p.muted) {
      entry.probe = []
      entry.muted = true
      entry.note = '已屏蔽，不检查更新'
    } else if (p.kind === 'git' && !entry.slug) {
      entry.probe = []
    } else if (p.kind === 'git') {
      entry.probe = [{ type: 'git', branch: null }]
    } else if (p.kind === 'snapshot') {
      entry.probe = [{ type: 'api', branch: null }]
    } else if (p.installed_from && entry.slug) {
      // A hand-downloaded release binary. There is no .git to diff and no registry
      // holding it, but the release page does publish a version — that is the only
      // honest upstream for this kind of install.
      entry.probe = [{ type: 'release' }]
      entry.kind = 'release'
    } else if (p.updater === 'uv' || p.updater === 'pipx') {
      // A package-manager install is a project row now, but its upstream is a
      // registry, not a git remote: PyPI for uv/pipx. Setting `kind` makes the
      // report say where the answer came from.
      entry.probe = [{ type: 'pypi' }]
      entry.kind = 'pypi'
    } else if (p.updater === 'npm') {
      entry.probe = [{ type: 'npm' }]
      entry.kind = 'npm'
    } else {
      entry.probe = []
    }
    out.push(entry)
  }

  // Plugins have no checkout to diff against; their upstream version comes from a
  // registry, so they are probed that way and only when they name something.
  for (const p of inv.plugins || []) {
    if (p.muted) continue // muted plugin: no registry lookup either
    const name = p.name || ''
    // Only real registry names can be looked up: local checkouts may carry a
    // path-like or scoped-local name no registry would answer for.
    // A `@local/` package is not a registry name, so it cannot be looked up — but
    // skipping it entirely left no row at all, and the page then showed "未检查"
    // for a plugin it could describe perfectly well. Report it the same way any
    // other non-registry install is: a row that says why there is no upstream,
    // instead of silence.
    if (name.startsWith('@local/')) {
      out.push({
        name,
        kind: String(p.install_source || 'local').toLowerCase(),
        slug: p.slug || '',
        npm_name: name,
        local_version: p.version || null,
        probe: [],
        note: '本地包（@local），不在任何 registry，无法比对上游',
      })
      continue
    }
    if (!name) continue

    // Where to ask depends on two things the scan records:
    //   profile — uv tool / pipx publish to PyPI, not npm
    //   source  — github: / link: / file: installs are not registry packages
    // Asking npm about `dsh-mcp-manager@github:hyqhyq3/...#v0.13.0` answered for an
    // unrelated same-named package at 0.6.0, so the row read "up to date" while the
    // local copy was actually ahead of it.
    const manager = String(p.profile || '').toLowerCase()
    const source = String(p.install_source || 'npm').toLowerCase()
    const slug = p.slug || ''
    let registry
    if (manager === 'uv tool' || manager === 'pipx') {
      registry = 'pypi'
    } else if (['github', 'link', 'file', 'unknown'].includes(source)) {
      // A repository was named, so its tags/HEAD are the upstream — that is true
      // for `github:` installs AND for a `link:`/`file:` checkout the operator keeps
      // in sync by hand. Only fall back to "none" when nothing names a repository
      // at all.
      // A plugin installed from a repo has no checkout to diff, so ask the
      // repository for its newest release/tag instead of using git.
      registry = slug ? 'tags' : 'none'
    } else {
      registry = 'npm'
    }

    if (registry === 'none') {
      out.push({
        name,
        kind: source,
        slug: p.slug || '',
        npm_name: name,
        local_version: p.version || null,
        probe: [],
        note: `本地安装（${source}），不在任何 registry，无法比对上游`,
      })
      continue
    }

    const probe = [{ type: registry }]
    if (registry === 'git') probe[0].branch = null
    out.push({
      name,
      kind: registry,
      slug: p.slug || '',
      npm_name: name,
      local_version: p.version || null,
      probe,
      note: p.note || '',
    })
  }

  return { projects: out }
}

async function main() {
  const projects = registryFromInventory()
  if (!(projects.projects || []).length) {
    console.error('缺少 inventory.json 或其中没有项目')
    return 2
  }
  const state = loadJson(STATE, {}) || {}
  const argv = process.argv.slice(2)

  // Re-running a check seconds after the last one answers nothing new and spends
  // the anonymous 60/hour GitHub budget on identical questions. Serve the cached
  // row set while it is fresh; `--force` exists for when the caller knows better.
  const cache = state.cache || {}
  let cacheAge = null
  if (cache.at) {
    const at = Number(cache.at)
    if (Number.isFinite(at)) cacheAge = Date.now() / 1000 - at
  }

  // A cached row records the LOCAL version it saw. After an upgrade that value is
  // stale, and serving it made a completed update look like it never happened: the
  // row kept saying "本地 0.45.0 → 上游 0.49.0" for six hours. So the cache is only
  // valid while every local version still matches what the scan now reports.
  let versionsUnchanged = true
  if (Array.isArray(cache.rows) && cache.rows.length) {
    // Compare only the names+local versions, not the upstream side: an upgrade
    // changes the former, a new release changes the latter.
    const cachedLocal = new Map(cache.rows.map((r) => [r.name || '', r.versions || '']))
    const currentLocal = new Map(
      (projects.projects || []).map((p) => [p.name || '', p.local_version || '']),
    )
    for (const name of new Set([...cachedLocal.keys(), ...currentLocal.keys()])) {
      if ((cachedLocal.get(name) || '') !== (currentLocal.get(name) || '')) {
        versionsUnchanged = false
        break
      }
    }
  }

  const fresh = cacheAge !== null && cacheAge < CACHE_TTL_SECONDS && versionsUnchanged
  if (fresh && Array.isArray(cache.rows) && cache.rows.length && !argv.includes('--force')) {
    const ageMin = Math.floor(cacheAge / 60)
    console.error(`（缓存 ${ageMin} 分钟内的结果，--force 可强制重查）`)
    const rows = cache.rows.map((r) => makeRow(r))
    const text = render(rows, projects)
    console.log(text)
    if (!argv.includes('--no-write')) {
      try {
        writeFileSync(REPORT, text, 'utf8')
      } catch {
        /* reported by the caller's own error handling */
      }
    }
    return 0
  }

  const t0 = Date.now()
  const rows = await checkAll(projects, state)
  const elapsed = (Date.now() - t0) / 1000

  state.cache = { at: Date.now() / 1000, rows }

  const text = render(rows, projects)
  console.log(text)
  console.error(`\n耗时 ${elapsed.toFixed(1)}s`)

  if (!argv.includes('--no-write')) {
    writeFileSync(REPORT, text, 'utf8')
    // `indent=1` matches the state file this replaced; it is a scratch file, so
    // the difference only matters for a human reading a diff of it.
    writeFileSync(STATE, JSON.stringify(state, null, 1), 'utf8')
    // The log is written by this process rather than by a shell redirect: Python's
    // UTF-8 output piped through cmd's GBK console produced mojibake, and appending
    // here sidesteps the whole encoding chain.
    try {
      appendFileSync(
        join(BASE, 'run.log'),
        `[${stampShortSeconds()}] ${rows.length} 个项目，有更新 ${rows.filter((r) => r.status === '有更新').length}，耗时 ${elapsed.toFixed(1)}s\n`,
        'utf8',
      )
    } catch {
      /* a log write must not fail the check */
    }
    console.error(`已写入 ${REPORT}`)
  }

  return rows.some((r) => r.status === '检查失败') ? 1 : 0
}

// Runnable two ways. `node lib/check.mjs` runs it directly; `lib/run.mjs` imports
// it and calls main() itself so one entry point owns the step order. The guard is
// what lets a test import `summarizeRelease` or `versionKey` without spending the
// GitHub quota on a full check.
const SELF = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (SELF) process.exitCode = await main()

export {
  main,
  versionKey,
  cmpVersion,
  parsePyver,
  satisfies,
  summarizeRelease,
  probeKey,
  makeRow,
  render,
}
