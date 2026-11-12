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
import { loadJson, normcase, stampShort, isoLocal } from './util.mjs'
import {
  walkFingerprint,
  tarFingerprint,
  compareFingerprints,
  fetchTarball,
  fetchVersionManifest,
} from './patch.mjs'

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

// …and how long a set that contains a failure stays authoritative. A failed
// probe is evidence about the network at that instant, not about upstream, so it
// stops being worth serving almost immediately: the next run is the retry.
const FAILED_CACHE_TTL_SECONDS = 60

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
 * How large a response this is willing to believe.
 *
 * Every one of these endpoints answers with a document we then hold entirely in
 * memory, and none of them is ours. A registry URL is supplied by whatever
 * package the disk happens to contain, so "the server is well behaved" is not an
 * assumption the scanner gets to make. The limits below are far above anything
 * these four APIs actually return — the largest real case measured was 16 KB —
 * so the ceiling only ever fires on something that is not the document we asked
 * for.
 */
const MAX_JSON_BYTES = 8 * 1024 * 1024

/** 413-ish: a body over the ceiling, read as a failure rather than as content. */
class TooLarge extends Error {
  constructor(bytes) {
    super(`响应超过 ${MAX_JSON_BYTES} 字节（读到 ${bytes}），已中止`)
    this.name = 'TooLarge'
  }
}

/**
 * Read a JSON body without trusting its length.
 *
 * `res.json()` hands the whole body to `JSON.parse` with no ceiling at all, and
 * `content-length` is a claim made by the other side — it can be absent on a
 * chunked response and wrong on a lying one. So the bytes are counted as they
 * arrive and the read stops at the limit instead of after it.
 *
 * The check is on accumulated bytes rather than on the header, because the
 * header is the part an unfriendly server controls.
 */
async function readJson(res) {
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > MAX_JSON_BYTES) throw new TooLarge(declared)

  // A response with no body stream (HEAD, 204) — none of our calls is either,
  // but falling through to `res.json()` here would quietly restore the unbounded
  // path this function exists to remove, so the ceiling is re-checked after.
  if (!res.body) {
    const text = await res.text()
    const size = Buffer.byteLength(text, 'utf8')
    if (size > MAX_JSON_BYTES) throw new TooLarge(size)
    return JSON.parse(text)
  }

  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_JSON_BYTES) {
      try { await reader.cancel() } catch { /* already gone */ }
      throw new TooLarge(total)
    }
    chunks.push(value)
  }

  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.byteLength }
  return JSON.parse(new TextDecoder('utf-8').decode(all))
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
    return [await readJson(res), null]
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

/**
 * A version string as comparable integers.
 *
 * Only the first number-shaped run in the string is read: everything before it
 * (a leading `v`, a package name recorded by a `npx` install like
 * `hyperframes@0.9.7 (npx)`) and everything after it (`(npx)`, `-beta`,
 * `+build.5`) is not part of the version being compared.
 *
 * Reading the whole string was wrong twice over. A leading `v` made `v1.3` split
 * into `['v1','3']`, where `v1` fails the digit test and becomes 0 — so a local
 * `v1.3` compared as *lower* than its own upstream `1.3` and the row reported
 * 有更新 on every run. And `hyperframes@0.9.7 (npx)` became `[0,9,0]`, reading
 * 0.9.7 as 0.9.0, which would have called a pending 0.9.37 update a bigger jump
 * than it is. Both forms come from real rows, not invented edge cases.
 *
 * `1.3.0` and `1.3` still compare differently on purpose, so a real patch release
 * still shows up.
 */
function versionKey(v) {
  const m = String(v).match(/\d+(?:[.\-+]\d+)*/)
  if (!m) return [0]
  return m[0]
    .split(/[.\-+]/)
    .slice(0, 4)
    .map((x) => (/^\d+$/.test(x) ? Number.parseInt(x, 10) : 0))
}

// ── probes ───────────────────────────────────────────────────────────────
/**
 * ls-remote for the upstream sha, then compare each local clone's HEAD.
 *
 * `branch` null means "the caller does not know" — resolve it from the remote.
 * `runGit` exists so the branch resolution can be tested without a network: the
 * bug this replaced was invisible to every test because guessing "main" only
 * fails against repositories that actually use something else.
 */
function probeGit(slug, branch, localPaths, runGit = git) {
  // `ls-remote --symref HEAD` answers `ref: refs/heads/<name>\tHEAD`. It is the
  // only authority on which branch is the default; a hardcoded guess turns
  // "this repo uses master" into a failure with nothing to read.
  //
  // The failure is carried out, not swallowed: if this probe is what broke (no
  // network, bad credentials) then "无法确定默认分支" hides the reason the user
  // needs, and the next message would blame the branch for a transport error.
  const resolveDefault = () => {
    const [headOut, headRc, headErr] = runGit(['ls-remote', '--symref', remoteUrl(slug), 'HEAD'])
    if (headRc === 0 && headOut) {
      const m = /refs\/heads\/(\S+)/.exec(headOut)
      if (m) return { branch: m[1], error: '' }
    }
    return { branch: '', error: (headErr || '').trim() }
  }

  let br = branch
  let resolveError = ''
  if (!br) {
    const resolved = resolveDefault()
    br = resolved.branch
    resolveError = resolved.error
  }
  if (!br) {
    const msg = (TOKEN ? resolveError.split(TOKEN).join('***') : resolveError).trim()
    return {
      ok: false,
      error: msg
        ? `无法确定默认分支: ${msg.slice(0, 200)}`
        : '无法确定默认分支（上游没有报告 HEAD 指向哪里）',
    }
  }

  const listBranch = (name) => runGit(['ls-remote', '--heads', remoteUrl(slug), `refs/heads/${name}`])
  let [out, rc, err] = listBranch(br)

  // `git ls-remote` exits 0 when the ref simply does not exist, so a wrong branch
  // name arrives as "no output, no error" — which is how a repo came to report the
  // literal string "ls-remote 失败: " with nothing after the colon. A branch name
  // coming from registry.json is a remembered guess and can be stale, so spend one
  // round trip re-resolving before calling it a failure.
  if ((rc !== 0 || !out) && branch) {
    const fallback = resolveDefault().branch
    if (fallback && fallback !== br) {
      br = fallback
      const again = listBranch(br)
      out = again[0]
      rc = again[1]
      err = again[2]
    }
  }

  if (rc !== 0 || !out) {
    const msg = (TOKEN ? err.split(TOKEN).join('***') : err).trim()
    return {
      ok: false,
      // Never an empty tail: "ls-remote 失败: " told the reader nothing, and the
      // empty string was git reporting success at matching nothing.
      error: msg
        ? `ls-remote 失败: ${msg.slice(0, 200)}`
        : `上游没有 ${br} 分支（仓库默认分支可能不是它）`,
    }
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
 * npm allows `repository` to be a string or `{type, url}`, and the url may carry
 * a `git+` prefix, a `.git` suffix, or the `git@github.com:` form. Anything that
 * is not GitHub is not this plugin's business, so it returns '' rather than
 * guessing.
 *
 * Takes the already-fetched manifest rather than fetching again: the caller has
 * the newest version's document open, and asking the registry twice for the same
 * answer is how this got slow in the first place.
 */
function slugFromRepository(repo) {
  const raw = repo && typeof repo === 'object' ? repo.url || '' : String(repo || '')
  // npm passes through whatever `git remote get-url` printed, which may end in a
  // slash when someone pasted a browse url instead of a clone url.
  const trimmed = raw.trim().replace(/\/+$/, '')
  const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(trimmed)
  return m ? m[1] : ''
}

/**
 * One short line saying what changed, for the row's hint.
 *
 * Release notes follow a shape: a section heading (`### Added / 新增`), a blank
 * line, then the actual bullet. Picking "### Added / 新增" tells the reader
 * nothing they did not already know from the version number; the bullet
 * underneath is the content.
 *
 * This used to keep the FIRST bullet and cut it to 20 characters, which turned
 * "邮件线程在只引用上一封的客户端（如 iOS Mail…" into "…（如 iO" — a summary that stops
 * mid-word cannot be acted on, and 20 characters is not enough to say what a
 * change is. The whole note is returned now. Length is the page's problem, not
 * the checker's: the row shows it in a fold the operator opens on purpose, so
 * there is nothing to protect them from by pre-truncating it here.
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
    // Provenance FIRST, while the link is still a link: a squashed changelog bullet
    // reads "* [PR] fix: x by @user in https://github.com/…/pull/5054". Dropping the
    // URL first leaves a dangling "in", and "by @github-actions[bot]" keeps its
    // "[bot]" suffix because `@[\w-]+` stops at the bracket. One pattern eats the
    // whole tail: the author handle (brackets included) and the "in" that introduced
    // the link.
    s = s.replace(/\s+by\s+@[^\s]+(\s+in\b)?\s*$/i, '')
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    s = s.replace(/https?:\/\/\S+/g, '')
    // Again, now that the URL is gone: "… fix: x by @user in https://…" only
    // becomes "… fix: x by @user in" after the URL is removed, so the first pass
    // could not see the tail it needed to eat. Two passes, in this order, is what
    // leaves neither a dangling "in" nor an author handle on the line.
    s = s.replace(/\s+by\s+@[^\s]+(\s+in\b)?\s*$/i, '')
    s = s.replace(/\s+in\s*$/i, '')
    // Markdown emphasis only. This used to strip every backtick, asterisk, angle
    // bracket AND underscore, which silently renamed the very identifiers the notes
    // talk about: `prompt_cache_key` became "promptcachekey", `stop_reason` became
    // "stopreason", `<goal_round>` became "goalround". Those are not decoration —
    // they are the subject of the sentence, and a reader searching for the setting
    // cannot find it. Only the markers go.
    s = s.replace(/`/g, '')
    s = s.replace(/\*\*/g, '')
    s = s.replace(/(^|\s)\*(?=\S)/g, '$1')
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

  // A section whose bullets are not changes to the software. "### Validation /
  // 发布验证" lists test counts and build checks, "### Notes / 使用说明" says how to
  // upgrade — true, but they answer "did this release pass CI", not "what is
  // different". Keeping the first bullet only used to hide this: the first bullet
  // is always in the first section, which is the changelog. Reading the whole note
  // means walking past these, so they have to be skipped by name.
  //
  // The word boundaries matter and used to be wrong: `test(ing)?\b` never matched
  // the heading "Tests", because the `\b` sits between `t` and `s` and both are
  // word characters. A release whose notes end with `## Tests` therefore had its
  // test counts summarised as if they were changes. Prefix matching has no such
  // hole, and a heading that merely starts with these words is still not a
  // changelog section.
  const NOISE_SECTION =
    /(validat|发布验证|test|测试|验证|note(?!w)|使用说明|install|安装|upgrade|升级|changelog|更新日志|contributor|贡献|credit|acknowledg|breaking|migration|迁移|download|下载|sponsor|赞助)/i

  // Tracked per line rather than per bullet because the heading decides for the
  // bullets under it, and a release note is a flat sequence of headings and items.
  let skipSection = false
  const headingOf = (raw) => {
    const s = raw.trim()
    const m = /^#{1,6}\s+(.*)$/.exec(s)
    if (m) return m[1]
    return ''
  }

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

  // A bullet that only restates the version. Automated changelogs open with
  // "release v0.1.209" — it is the tag the reader is already looking at, written
  // out again, and with the whole note now on screen it would spend the first line
  // saying nothing.
  const RELEASE_ONLY = /^(release[ds]?|bump(ed)?( version)?|version bump|publish(ed)?|chore\(release\))\b[\s:]*v?[\d][\w.\-+]*\s*$/i

  // Headings that name the document rather than a kind of change. As a group label
  // "What's Changed" says nothing a bullet list does not already say.
  const GENERIC_SECTION =
    /^(what'?s changed|changes?|changelog|release notes?|更新内容|变更内容|本次更新)$/i

  const sectionTitle = (raw) => {
    const parts = String(raw).split(/\s*\/\s*/).map((x) => x.trim()).filter(Boolean)
    const cjk = parts.filter((p) => hasCjk(p))
    const title = (cjk.length ? cjk.join(' / ') : parts[parts.length - 1] || '').trim()
    if (!title || GENERIC_SECTION.test(title)) return ''
    return title
  }

  /**
   * Strip the labels an author put in front of a sentence.
   *
   * Two shapes, both "where this change came from" rather than "what it does":
   * a bracketed area tag ("[storage]") and a conventional-commit prefix
   * ("fix(web):", "revert #5202:"). `clean` already removes the prefix at the start
   * of a line, but a bilingual bullet carries its own copy on each half —
   * "feat(web): English… | feat(web): 中文…" — so the half that survives the split
   * still has one, and the colon rule below then treats that label as the subject.
   * That is where "feat(web)" and "revert #5202" came from in the summary.
   */
  const stripLabel = (text) => {
    let s = String(text || '').trim()
    s = s.replace(/^\[[^\]]{1,24}\]\s*/, '')
    // "(ai: anthropic/claude-opus-4-6)" names the model that drafted the entry. It
    // is provenance, and left in place it becomes the first thing read on a line
    // whose subject is the change.
    s = s.replace(/^\(\s*ai\s*:[^)]*\)\s*/i, '')
    s = s.replace(
      /^(?:feat|fix|hotfix|chore|refactor|docs|test|perf|build|ci|style|revert|wip)(?:\([^)]{0,32}\))?!?\s*(?:#\d+)?\s*[:\-—]\s*/i,
      '')
    return s.trim()
  }

  /**
   * One change, said once.
   *
   * Release notes are written for someone about to debug the change, not for
   * someone deciding whether to install it: the bullet carries the symptom, the
   * root cause, the fix and the file it touched. A summary keeps the first of
   * those, because that is the part the reader recognises their own problem in.
   */
  const condense = (text) => {
    let s = String(text || '').trim()

    // Bilingual changelogs write the same change twice: "English sentence |
    // 中文说明". The reader needs one of them. Preferring the Chinese side matches
    // how the rest of this page speaks, and the longer side is the one carrying
    // the explanation rather than the label.
    if (/\s\|\s/.test(s)) {
      const parts = s.split(/\s\|\s/).map((x) => x.trim()).filter(Boolean)
      if (parts.length > 1) {
        const cjkParts = parts.filter(hasCjk)
        const pool = cjkParts.length ? cjkParts : parts
        s = pool.reduce((a, b) => (b.length > a.length ? b : a), '')
      }
    }

    // The surviving half brings its own label along; see stripLabel.
    s = stripLabel(s)

    // One sentence. What follows the first full stop is usually the mechanism or
    // the reproduction, which is what makes a six-item changelog unreadable.
    //
    // Two alphabets, two rules. A CJK full stop is unambiguous. An ASCII period is
    // not: it is also how versions (v0.2.3), filenames (check.mjs), abbreviations
    // (e.g.) and ellipses are written. Requiring whitespace after it, and a capital,
    // digit, quote or bracket after that, skips every one of those. Requiring the
    // character before it not to be a lone capital skips initials like J. Smith.
    const m = /^(.{4,}?)[。！？]/.exec(s)
    if (m) {
      s = m[1]
    } else {
      const e = /^(.{4,}?[^A-Z0-9])[.!?]+\s+(?=[A-Z0-9\"'“‘(\[])/.exec(s)
      if (e) s = e[1]
    }

    // A "subject：detail" bullet keeps its subject. Twenty Chinese characters in a
    // changelog are almost always the subject and everything after them is the
    // proof, so the colon is where the summary naturally ends.
    //
    // The CJK guard is what separates a subject from a label: "claude 子代理并行同型
    // 派发合流:…" has prose on the left and should be cut, while "fix(web):…" was a
    // label that stripLabel has already removed. Anything left that is pure ASCII
    // is a code path or a scope, not a sentence, and cutting there would file the
    // change under a word the reader cannot act on.
    const colon = /^([^：:]{8,})[：:]/.exec(s)
    if (colon && hasCjk(colon[1])) s = colon[1]

    // A wall of text is not a summary either. Changelog bullets often read
    // "subject — everything that went wrong, and why"; the dash is where the
    // subject ends. Only applied when the entry is plainly too long to take in as
    // one line, because for a short entry the dash may be carrying the meaning.
    if (s.length > 90) {
      const cut = /^(.{6,}?)\s*(?:——|—|；|;)\s*\S/.exec(s)
      if (cut) s = cut[1]
    }

    return s.trim()
  }

  // Grouped, because a changelog already is. Collapsing "Fixed" and "Added" into
  // one flat list throws away the only structure the author gave the reader.
  const groups = [{ title: '', bullets: [] }]

  for (const ln of lines) {
    const s = ln.trim()
    if (!s) continue
    // A heading decides what the lines under it are about.
    const h = headingOf(s)
    if (h) {
      skipSection = NOISE_SECTION.test(h)
      if (!skipSection) groups.push({ title: sectionTitle(h), bullets: [] })
      continue
    }
    if (isHeading(s)) continue
    if (INSTALL_NOISE.test(s) || platformLabel.test(s)) continue
    if (skipSection) continue
    // A bullet starts with '-', '*', or is a numbered item; a continuation line of
    // the previous bullet is not a candidate. The English translation that usually
    // follows a Chinese bullet is indented, so it fails this test and is dropped
    // without needing the "same bullet in another language" heuristic below.
    if (!/^[\-*]|^\d+[.)]/.test(s)) continue
    const c = clean(s)
    if (c.length < 4) continue
    if (HANDLE_ONLY.test(c)) continue
    if (RELEASE_ONLY.test(c)) continue
    // An English translation line usually follows the Chinese one and repeats it;
    // skip lines that are plainly the same bullet in English.
    if (!hasCjk(c) && groups[groups.length - 1].bullets.length
      && hasCjk(groups[groups.length - 1].bullets[groups[groups.length - 1].bullets.length - 1])) continue
    groups[groups.length - 1].bullets.push(c)
  }

  // Dedupe across the whole note, not per section: a change that appears under two
  // headings is still one change, and the second copy is exactly the noise a
  // summary is supposed to remove.
  const seen = new Set()
  const key = (s) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 40)
  const kept = []
  for (const g of groups) {
    const out = []
    for (const raw of g.bullets) {
      const c = condense(raw)
      if (c.length < 6) continue
      const k = key(c)
      if (!k || seen.has(k)) continue
      seen.add(k)
      out.push(c)
    }
    if (out.length) kept.push({ title: g.title, bullets: out })
  }

  if (!kept.length) {
    // No bullets at all: a hand-written note is prose. Three things have to happen
    // before it is a summary, and the first version of this did none of them:
    // a 1359-character English release came back at 93% of its original size,
    // test counts included.
    //
    //   1. Join hard-wrapped lines back into paragraphs. Release notes are wrapped
    //      at ~80 columns, so reading line by line treats half a sentence as a whole
    //      item, and no sentence rule can fire on half a sentence.
    //   2. Honour skipSection. "## Tests" and "## Install" are not changes to the
    //      software; the bullet path skips them by heading, and this path ignored
    //      the flag entirely.
    //   3. Cut each paragraph to its opening sentence, which is where the claim is.
    //
    // One entry per paragraph, no character budget: a paragraph that genuinely needs
    // two sentences still reads, and the page shows all of them.
    const paras = []
    let skipProse = false
    let buf = []
    const flush = () => {
      // CJK text is not spaced; joining it with a space would insert a visible gap.
      if (buf.length) paras.push(buf.join(hasCjk(buf[0]) ? '' : ' '))
      buf = []
    }
    for (const ln of lines) {
      const s = ln.trim()
      if (!s) { flush(); continue }
      const h = headingOf(s)
      if (h) { flush(); skipProse = NOISE_SECTION.test(h); continue }
      if (isHeading(s)) { flush(); continue }
      if (INSTALL_NOISE.test(s) || platformLabel.test(s)) { flush(); continue }
      if (skipProse) continue
      buf.push(s)
    }
    flush()
    const prose = []
    for (const p of paras) {
      const c = condense(clean(p))
      if (c.length >= 6 && !HANDLE_ONLY.test(c) && !RELEASE_ONLY.test(c)) prose.push(c)
    }
    return prose.join('\n').trim()
  }

  const total = kept.reduce((n, g) => n + g.bullets.length, 0)
  // A single change needs no list marker — one bullet with a dot in front reads
  // like a fragment of something that got cut off.
  if (total === 1) return kept[0].bullets[0]

  // No length budget anywhere in here. The old 20-character cut ended every entry
  // mid-word ("…（如 iO", "…(fast 模式加双") and left the reader unable to tell
  // what changed; a summary is allowed to be as long as the changes are.
  //
  // Newlines, not separators: `render` escapes them to a literal "\n" so the row
  // stays one table line, and `parseReport` puts them back so the page can show one
  // change per line.
  const lines2 = []
  for (const g of kept) {
    if (g.title) lines2.push(`${g.title}（${g.bullets.length} 项）`)
    for (const b of g.bullets) lines2.push(b)
  }
  return lines2.join('\n').trim()
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
    data = await readJson(res)
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
  // `/latest` is the manifest of one version; the bare package path is the whole
  // packument, i.e. every release ever published. billion-context's packument is
  // over 8 MB and tripped the response cap, and nothing here reads anything that
  // is not in the newest manifest anyway — `version` and `repository` are both on
  // it. Measured: 4.5 KB instead of 8.4 MB.
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`
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
    data = await readJson(res)
  } catch (exc) {
    return { ok: false, error: `${exc.name || 'Error'}: ${exc.message || exc}` }
  }

  const ver = String(data.version || '').trim()
  if (!ver) return { ok: false, error: 'registry 响应里没有 version' }

  // The registry copy names the repository; the release feed is where "what
  // changed in this version" lives. A package's `description` only says what the
  // package is, which reads identical every release and answers a different
  // question.
  const out = { ok: true, latest: ver }
  const slug = slugFromRepository(data.repository)
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
/**
 * Does the copy on disk match the artifact published for the same version?
 *
 * Every version comparison in this file can say "up to date" about an install
 * that was hand-edited afterwards: a `file:` tarball the operator patched, a
 * `link:` checkout they keep fixing by hand. The version string is identical in
 * both cases, so no registry answer can tell them apart — only the bytes can.
 *
 * Only meaningful when the exact version on disk is also published. A fork that
 * bumped its own version, or a `github:` install of an unreleased commit, has
 * nothing to diff against and gets `checked: false` with the reason, which the
 * caller leaves alone rather than dressing up as a finding.
 */
async function probePatch(proj) {
  const version = proj.local_version || ''
  const root = proj.install_path || ''
  const name = proj.npm_name || proj.name || ''
  if (!version || !root || !name) return { checked: false, why: '缺少版本或安装路径' }
  if (!isdir(root)) return { checked: false, why: '安装目录不存在' }
  // Only an install that came from npm (or from a tarball of it) has the published
  // artifact as its yardstick. A `github:` install of a tag is built from the
  // repository, not from the registry copy, so a byte difference there is expected
  // and says nothing about hand edits.
  const source = String(proj.install_source || '').toLowerCase()
  if (source && source !== 'npm' && source !== 'file') {
    return { checked: false, why: `安装来源是 ${source}，没有可对照的 npm 产物` }
  }

  const man = await fetchVersionManifest(name, version)
  if (!man.ok) return { checked: false, why: man.error || '取不到该版本的 npm 元数据' }
  const dist = man.manifest && man.manifest.dist ? man.manifest.dist : {}
  if (!dist.tarball) return { checked: false, why: '该版本没有 tarball 地址' }

  const tgz = await fetchTarball(dist.tarball)
  if (!tgz.ok) return { checked: false, why: tgz.error || '包下载失败' }

  let localMap
  let pubMap
  try {
    localMap = walkFingerprint(root)
    pubMap = tarFingerprint(tgz.buf)
  } catch (exc) {
    return { checked: false, why: `指纹计算失败: ${exc.message || exc}` }
  }
  if (!pubMap.size) return { checked: false, why: '包内没有可比对的文件' }

  const cmp = compareFingerprints(localMap, pubMap)
  return { checked: true, ...cmp, files: localMap.size }
}

/**
 * Turn a patch verdict into a status sentence.
 *
 * Only rows that were about to read "up to date" are candidates. A row with a
 * real update pending already has something to act on, and "is this hand-edited"
 * would not change what to do about it.
 *
 * `base` is the sentence the version comparison produced, kept as the prefix so
 * the versions stay readable; the patch is what is *added* to it.
 */
function applyPatchVerdict(r, pp, base) {
  if (!pp.checked || !pp.patched) return
  const files = pp.differing.slice(0, 6).join('、')
  const more = pp.differing.length > 6 ? ` 等 ${pp.differing.length} 个文件` : ''
  const extras = pp.onlyLocal.length ? `；另有 ${pp.onlyLocal.length} 个仅本地存在的文件` : ''
  r.status = '有本地补丁'
  r.detail = `${base}，但磁盘内容与发布的同名版本不同${files ? `（${files}${more}）` : ''}${extras}`
}

/** One row of the report. */
function makeRow({ name, kind, status = '', detail = '', slug = '', clones = [], versions = '', summary = '', local = '' }) {
  return {
    name,
    kind,
    status,
    detail,
    slug,
    clones,
    versions,
    // The local version on its own, not the `本地 → 上游` display string. The
    // cache decides whether to re-run by asking "did any local version change",
    // and comparing that question against `versions` compared `0.9.12` with
    // `0.9.12 → 0.9.12` — never equal, so the cache answered "stale" forever and
    // every check spent its full 30 seconds even seconds after the last one.
    local: local || '',
    // A one-line description of what the new version changed, kept separate from
    // `detail` so the row can show it in its own slot instead of lengthening the
    // status sentence.
    summary,
  }
}

/**
 * Whether a cached row set still describes the install that is on disk now.
 *
 * Only the local versions are compared. An upgrade changes those; a new upstream
 * release changes only the other half of the `本地 → 上游` line, and that is
 * exactly the case the cache exists to avoid re-asking about.
 *
 * The comparison has to be made against `r.local` (the bare version) and not
 * against `r.versions` (the display line): comparing `"0.9.12 → 0.9.12"` with
 * `"0.9.12"` is never equal, so every run decided the cache was stale and spent
 * its full half-minute re-asking. Rows written before `local` existed fall back
 * to the left half of `versions` so an upgrade still re-checks once instead of
 * pinning a stale set forever.
 */
function cacheStillDescribes(cachedRows, projects) {
  if (!Array.isArray(cachedRows) || !cachedRows.length) return true
  const localOf = (r) => r.local || String(r.versions || '').split('→')[0].trim()
  const cachedLocal = new Map(cachedRows.map((r) => [r.name || '', localOf(r)]))
  const currentLocal = new Map((projects || []).map((p) => [p.name || '', p.local_version || '']))
  for (const name of new Set([...cachedLocal.keys(), ...currentLocal.keys()])) {
    if ((cachedLocal.get(name) || '') !== (currentLocal.get(name) || '')) return false
  }
  return true
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
  // `null`, not `'main'`: probeGit can ask the remote for its default branch, but
  // only when it is allowed to see "nobody told me". A fallback here would make
  // that resolution unreachable, and a repo whose default is `master` would fail
  // every scan with an empty error.
  if (how === 'git') return probeGit(proj.slug, pr.branch || null, proj.paths || [])
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
      local: proj.local_version || '',
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
        got = cached !== undefined ? cached : probeGit(proj.slug, pr.branch || null, proj.paths || [])
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
          // A row about to read "up to date" can still be a hand-edited copy: the
          // version string is identical, the bytes are not. This is the only place
          // that can tell the two apart, and it is why this lane asks at all.
          if (r.status === '最新' || r.status === '本地领先') {
            const pp = await probePatch(proj)
            if (pp.checked && pp.patched) applyPatchVerdict(r, pp, r.detail)
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
            // Same rule as the tags lane: a summary belongs to an update that is
            // actually pending. This lane computed got.summary inside probeRelease
            // and never copied it onto the row, so a release-sourced binary showed
            // 有更新 with an empty notes column while a plugin row showed its notes.
            r.summary = got.summary || ''
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
            // Same question as the tags lane: a registry-sourced version string says
            // nothing about whether the files under node_modules are still the ones
            // the registry shipped. Asked before the note is appended, so the note
            // stays the last clause of the sentence. Skipped for pypi, whose
            // artifact is a wheel no npm endpoint can answer for.
            if (how === 'npm') {
              const pp = await probePatch(proj)
              if (pp.checked && pp.patched) applyPatchVerdict(r, pp, r.detail)
            }
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

/**
 * @param {object} [opts]
 * @param {string} [opts.checkedAt] When the answers were actually fetched, if that
 *   is not now. Absent for a real run; set when the rows came from the cache, so
 *   the report cannot claim a check that never happened. A header reading
 *   "生成时间 16:20" over answers fetched at 10:05 is worse than no timestamp: it
 *   is the page asserting something false about its own freshness.
 */
function render(rows, _projects, opts = {}) {
  const order = {
    有更新: 0,
    上游已下架: 1,
    上游有新版: 2,
    检查失败: 3,
    无上游: 4,
    未见新版: 5,
    // Above plain 最新 on purpose: a hand-edited install is not a problem to fix,
    // but it is the thing that explains "why does this behave differently from the
    // released package", and burying it among the up-to-date rows loses that.
    有本地补丁: 6,
    最新: 7,
  }
  const sorted = rows.slice().sort((a, b) => {
    const x = order[a.status] ?? 9
    const y = order[b.status] ?? 9
    if (x !== y) return x - y
    const an = a.name.toLowerCase()
    const bn = b.name.toLowerCase()
    return an < bn ? -1 : an > bn ? 1 : 0
  })
  // When the answers are not from this minute, say so where the timestamp is
  // rather than at the bottom: the header is what the page reads and what a
  // human glances at. `checkedAt` is the moment they were fetched.
  const stamp = opts.checkedAt || stampShort()
  const ageNote = opts.checkedAt ? '（缓存结果，非本次检查）' : ''

  const nUp = sorted.filter((r) => r.status === '有更新').length
  const nNew = sorted.filter((r) => r.status === '上游有新版').length
  const nGone = sorted.filter((r) => r.status === '上游已下架').length
  const nOk = sorted.filter((r) => ['最新', '未见新版', '有本地补丁'].includes(r.status)).length
  // Counted inside 已最新 rather than as its own column: the versions match, so a
  // separate total would double-count the row and make the header disagree with
  // the row count. The parenthetical is what keeps the number honest — it says how
  // many of those matching rows are not byte-for-byte the published package.
  const nPatched = sorted.filter((r) => r.status === '有本地补丁').length
  const nErr = sorted.filter((r) => r.status === '检查失败').length
  const nNa = sorted.filter((r) => r.status === '无上游').length

  const out = [
    '# GitHub 项目更新报告',
    '',
    `生成时间：${stamp}　｜　共 **${sorted.length}** 个项目${ageNote}`,
    `有更新 **${nUp}**　上游有新提交 ${nNew}　已下架 ${nGone}　已最新 ${nOk}　失败 ${nErr}　无上游 ${nNa}`,
    // Only mentioned when it happens, and as a clarification of the number above:
    // `parseReport` reads 已最新 out of that line, so adding a seventh column
    // would change what an existing page displays. The suffix cannot, because the
    // pattern stops at the first number it finds after 已最新.
    ...(nPatched ? [`（其中 ${nPatched} 个版本的磁盘内容和发布版不同，见各行「有本地补丁」）`] : []),
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
    // Neither green nor red: nothing is wrong and nothing is owed. The patch is a
    // deliberate local state worth seeing, which is exactly why it is not just
    // folded into ✅.
    有本地补丁: '🩹',
  }
  for (const r of sorted) {
    const mark = MARK[r.status] || ''
    // The summary is its own column: it describes the NEW version, which is
    // unrelated to "what is installed vs what is upstream" in the detail.
    //
    // A pipe would end the cell, so it becomes a fullwidth one. Newlines are the
    // separator between bullets and a table row cannot hold them, so they travel
    // as a literal "\n" and `parseReport` turns them back into line breaks —
    // which is what lets the page show one change per line instead of a paragraph.
    const summary = String(r.summary || '')
      .split('|').join('｜')
      .split(/\r?\n/).join('\\n')
    // The detail keeps its own sentence whole. It is a status line ("本地 1.2.3 →
    // 上游 1.3.0 ｜ 2026-10-31"), never long enough to need a cut, and slicing it
    // at 70 was erasing the date and the note on rows with a long path or slug.
    out.push(`| ${r.name} | ${r.kind} | ${mark} ${r.status} | ${String(r.detail || '').split('|').join('｜')} | ${summary} |`)
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
 * Which upstream a project row should be checked against.
 *
 * Returns `{probe, kind, muted}`. `kind` is only set when the answer differs from
 * what the row already says, and it exists so the report can name where the answer
 * came from ("npm" / "release" / "pypi") rather than echoing the scan's guess.
 *
 * Every rule here is a way of knowing something about a directory that a plain
 * `ls` cannot tell you. Getting one wrong is silent: a row with an empty probe is
 * reported 无上游 — "there is nothing upstream" — which is indistinguishable from
 * "we never asked". That is exactly how two real rows sat behind a false answer
 * for days: `DSHgo` had four published releases and `hyperframes` had a `latest`
 * on npm, and the page said 无上游 for both.
 */
function laneForProject(p) {
  // A muted project is skipped by emptying its probe list, not by dropping the
  // row. Dropping it would make the page and the checker disagree about what
  // exists — the exact drift registryFromInventory exists to end — and it would
  // also hide the fact that it was deliberately parked. `muted` survives in
  // inventory.json so the page can say why.
  if (p.muted) return { probe: [], muted: true }

  const slug = p.slug || ''
  const kind = String(p.kind || 'git')
  const updater = String(p.updater || '')

  // A git checkout with a remote: compare commits.
  if (kind === 'git') return { probe: slug ? [{ type: 'git', branch: null }] : [] }
  // An unpacked archive whose upstream is compared by date.
  if (kind === 'snapshot') return { probe: [{ type: 'api', branch: null }] }

  // A hand-downloaded release binary. There is no .git to diff and no registry
  // holding it, but the release page does publish a version — the only honest
  // upstream for this kind of install.
  //
  // Two records say "this came from a release page". `installed_from` is written
  // by a `.dsh-source.json` next to the binary; nobody has one of those. A
  // download logged in queue.json instead carries `"method": "release"`, which
  // build.mjs copies onto the row as `kind: 'release'`. Reading only the first
  // field made this branch unreachable in practice.
  if ((p.installed_from || kind === 'release') && slug) {
    return { probe: [{ type: 'release' }], kind: 'release' }
  }

  // A package-manager install is a project row too, but its upstream is a
  // registry, not a git remote. `updater` is written by the scanner for installs
  // it recognised; queue-logged rows have no `updater` at all, only the method
  // they were installed by — read that as the same fact.
  const via = updater || (kind === 'npm' || kind === 'uv' || kind === 'pipx' ? kind : '')
  if (via === 'uv' || via === 'pipx') return { probe: [{ type: 'pypi' }], kind: 'pypi' }
  if (via === 'npm') return { probe: [{ type: 'npm' }], kind: 'npm' }

  return { probe: [] }
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
      // Where the bytes actually live. Only the patch check reads this, and only
      // for rows whose upstream is a registry — a git checkout is compared against
      // its remote instead.
      install_path: p.path || '',
    }
    // Which upstream to ask, and what to call it. Extracted because deciding it
    // wrongly is silent: a row with no probe is reported 无上游, which reads as
    // "there is nothing upstream" and is indistinguishable from "we never asked".
    const lane = laneForProject(p)
    entry.probe = lane.probe
    if (lane.kind) entry.kind = lane.kind
    if (lane.muted) {
      entry.muted = true
      entry.note = '已屏蔽，不检查更新'
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
      // Carried through so the checker can look at the installed bytes, not just
      // the version string: a `file:`/`link:` install is routinely hand-edited,
      // and its version still reads identical to the published one.
      install_path: p.install_path || p.path || '',
      install_source: source,
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
  const versionsUnchanged = cacheStillDescribes(cache.rows, projects.projects)

  // A failure is a statement about the network at that moment, not about
  // upstream: `TypeError: fetch failed` while a VPN is down says nothing about
  // whether a release exists. Serving such a row for the full six hours meant a
  // machine that came back online kept showing twelve red rows until someone
  // thought to pass --force. So a cached set that contains a failure expires in
  // a minute; one that is all answers lasts the normal TTL.
  const hasFailures = Array.isArray(cache.rows) && cache.rows.some((r) => r.status === '检查失败')
  const ttl = hasFailures ? FAILED_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS
  const fresh = cacheAge !== null && cacheAge < ttl && versionsUnchanged
  if (fresh && Array.isArray(cache.rows) && cache.rows.length && !argv.includes('--force')) {
    const ageMin = Math.floor(cacheAge / 60)
    console.error(`（缓存 ${ageMin} 分钟内的结果，--force 可强制重查）`)
    const rows = cache.rows.map((r) => makeRow(r))
    // `cache.at` is when these answers were fetched, in seconds. Passing it is
    // what stops the report from stamping itself with the current minute: the
    // page reads that header as "last checked", and a cached answer is a real
    // answer from an earlier time, not a check that just happened.
    const text = render(rows, projects, { checkedAt: stampShort(new Date(cache.at * 1000)) })
    console.log(text)
    if (!argv.includes('--no-write')) {
      try {
        writeFileSync(REPORT, text, 'utf8')
      } catch {
        /* reported by the caller's own error handling */
      }
    }
    // Same exit code a fresh run of this same row set would have produced. It
    // used to be a flat 0, so a caller reading the code was told the check was
    // clean exactly when it had been answered from a cache full of failures.
    return rows.some((r) => r.status === '检查失败') ? 1 : 0
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
  probeGit,
  makeRow,
  laneForProject,
  cacheStillDescribes,
  render,
  readJson,
  MAX_JSON_BYTES,
  TooLarge,
  slugFromRepository,
  CACHE_TTL_SECONDS,
  FAILED_CACHE_TTL_SECONDS,
}
