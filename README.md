# dsh-github-watch

A DeepSeek Harness plugin that answers one question honestly: **what GitHub projects are on this machine, and which of them are behind upstream?**

Adds a Settings page (设置 → 已下载项目) listing every tracked repo with its size, dependencies, upstream status and last check, and lets you update, mute or delete them from there.

## What it does

| | |
|---|---|
| **Tabs** | 项目 / 插件 / 已屏蔽 — side by side, no scrolling |
| **One row per repo** | A second clone of the same upstream is folded into the row that represents it, marked `+1` and listed in the row's detail. The row counts the repo, not the copies |
| **Sizes** | Per project, showing the project separate from its dependencies and from work output you produced |
| **Upstream** | `git ls-remote` for clones, the GitHub API for snapshots and releases, `registry.npmjs.org` for npm packages, PyPI for `uv`/`pipx` tools |
| **Update** | `git pull --ff-only`, refused when the tree is dirty or has no `.git` |
| **Mute** | Stops checking for updates, keeps the repo, moves it to its own tab |
| **Delete** | Two-step: reports what would be lost, split into re-downloadable / edited locally / your own output, then deletes |
| **Scan** | Walks the disk for new clones and checks upstream, with per-project progress |

## Why it exists

Downloaded repos rot. You clone something to try it, keep it, and six months later you have no idea which of forty directories matter, which have upstream fixes, or which are 2 GB of dependencies you already forgot about.

`git status` does not answer that. Neither does a file manager. The information needed is the *join*: what is on disk, what its upstream did, and what you would lose by deleting it.

## Install

```bash
# 1. into your DSH profile
cd <your-dsh-profile>
npm install github:sumbge/dsh-github-watch

# 2. add "dsh-github-watch" to dsh.profile.bundles in that profile's package.json
```

Restart DSH. The Settings page appears as 已下载项目.

No install-time step, no `postinstall`, no build. Everything ships in the package
and runs on the Node that is already running DSH.

## Get data into it

The plugin is only the view. The three steps that produce what it reads live in
`lib/` and run on `process.execPath` — the same Node DSH itself is running, so
there is nothing to install and no interpreter to locate:

```bash
node lib/run.mjs inventory   # walk the disk
node lib/run.mjs build       # merge with inventory + queue
node lib/run.mjs check       # query upstreams
```

| Step | File | Does |
|---|---|---|
| `inventory` | `lib/inventory.mjs` | walks the scan roots, finds clones and installed packages, writes `local_inventory.json` |
| `build` | `lib/build.mjs` | merges the walk with the DSH profile's declared plugins and the reported-download queue, writes `inventory.json` |
| `check` | `lib/check.mjs` | asks each upstream for its latest version, writes `report.md` and `state.json` |

The plugin runs these in that order for you — the page's **扫描** button does
exactly this, and the same pipeline runs after an update. You only need the
commands above to drive it by hand.

`check` caches its answers for six hours, and refuses the cache the moment any
local version changes — an upgrade you just did must not keep showing the version
you had before. A set that contains a failure is a different case: it speaks about
the network at that second, not about upstream, so it is only reused for sixty
seconds and the next run retries. `--force` re-asks regardless.

The cache is for runs nobody is watching. Pressing **检查更新** always re-asks
upstream, because that is what the label says the button does; answering a click
with a six-hour-old result would be a different question than the one asked. When
a run does use the cache, the report says so in its own header
(`生成时间：… （缓存结果，非本次检查）`) and dates it to when the answers were
fetched, so the page can never claim a check that did not happen.

Where the data lands:

```bash
export DSH_GITHUB_WATCH_DIR=~/.dsh-github-watch     # or put it in config.json
```

With nothing configured, the walk covers `~/Desktop`, `~/Documents`,
`~/Downloads`, and `%LOCALAPPDATA%\Programs` (where a downloaded release binary
lands when it is installed rather than cloned).

**A fresh install shows an empty page until a scan has run.** That is not a bug:
there is nothing to show yet.

Nothing assumes a profile named `desktop`. DSH exports `DSH_PROFILE_DIR` and
`DSH_PROFILE` to child processes, and both are honoured; the fallback reads
`~/.dsh/profiles/*/node_modules` rather than one hardcoded directory. The same
holds for the data directory (`DSH_GITHUB_WATCH_DIR`) and the scan roots
(`DSH_GITHUB_WATCH_ROOTS`, semicolon-separated). `config.json` is gitignored, so
machine-specific paths never reach the repository.

The only external programs used are `git` (for `ls-remote` and `pull`) and `gh`
(for the account card). Neither is required for the page to load.

## Telling it what the disk cannot

A walk over the disk answers "what is here". It cannot answer "who fetched this,
and why" — and for two kinds of download it cannot even answer "what is this":

| Download | Recognisable without help? | Why |
|---|---|---|
| `git clone` | ✅ | the `.git` directory names the upstream |
| `npm i -g` / `uv tool install` | ✅ | the manifest names the package |
| GitHub Release `.zip` / bare binary | ❌ | no `.git`, no manifest — nothing on disk says where it came from |
| `npx <pkg>` | ❌ | a cache entry, not an install |

Two mechanisms cover the gap.

### 1. `.dsh-source.json` next to an installed binary

A hand-downloaded release has nothing for the scanner to read. Drop this file in
the install directory and it becomes a tracked project, checked against the
repo's release feed:

```json
{
  "name": "github-mcp-server",
  "version": "2.0.3",
  "summary": "GitHub's official MCP Server (Go binary)",
  "source": "github-release",
  "repository": "github/github-mcp-server",
  "installed_from": "https://github.com/.../v2.0.3/github-mcp-server_Windows_x86_64.zip",
  "entry": "github-mcp-server.exe"
}
```

Without it, the directory is treated as an application folder and never listed.

### 2. `queue.json` — the session reports what it downloaded

`~/.dsh-github-watch/queue.json` is an append-only list that agent sessions add
to when they download something:

```json
[
  {
    "slug": "owner/repo",
    "name": "repo",
    "path": "C:\\path\\to\\checkout",
    "method": "git clone",
    "version": "1.2.3",
    "at": "2026-10-30T22:00:00+08:00",
    "want": "why this was fetched — the only field that explains it months later"
  }
]
```

Entries are folded straight into the project list by the `build` step: a
download the session reported shows up next to one the disk walk found, and the
`want` field is what explains it months later.

The rule that tells a session to write this lives in the DSH skill
`~/.dsh/skills/record-github-downloads.md`, which any DSH session loads from its
skill catalog. Run `node lib/run.mjs build` afterwards to fold the queue into
`inventory.json`.

## Safety

Deletion is real (`rm -rf`), so it is guarded:

- **Two steps.** The confirm dialog names the three kinds of bytes separately — re-downloadable, edited locally, and work output you cannot get back. A single "delete 3.2 GB" hides the only part that matters.
- **Path allowlist.** `~/Desktop`, `~/Documents`, `~/Downloads`, plus any roots in `DSH_GITHUB_WATCH_ROOTS` — and, for plugins, a package directory directly inside a DSH profile's `node_modules`. A malformed path in `inventory.json` cannot become a delete of `C:\`.
- **Record before delete.** `watched.json` gets a `removed` entry first, so a delete that fails halfway still leaves evidence of intent. If `rm` then throws, the entry is rewritten as `remove-failed` with the error and `size_freed_mb: 0` — the attempt stays on record, but it is never read back as a completed deletion.
- **Mute is not hide.** A muted project stays in its own tab. Hiding it would make "I muted it" and "it vanished" look identical.

## What the statuses mean

| Status | Meaning |
|---|---|
| 有更新 | Local HEAD differs from upstream — `git pull` applies |
| 上游有新版 | No `.git` to diff; date comparison only. **Not** proof the local copy can be updated |
| 上游有新提交 | Same, for snapshot projects |
| 上游已下架 | The package no longer exists upstream |
| 受 Python 版本限制 | Newer versions exist but require a Python the tool's venv does not have |
| 有本地补丁 | The version string matches what upstream publishes, but the bytes on disk do not. See below |
| 本地领先 | Local version is higher than any upstream release — self-maintained |
| 已屏蔽 | You muted it; it is not checked |
| 已卸载 | You deleted it; recorded in `watched.json`. The row is shown only in the session where you pressed delete — see below |
| 目录不见了 | Gone from disk with no removal record — someone else deleted it, or it moved |
| 无上游 | Nothing was asked, because there is nowhere to ask. See below |

The last two are deliberately distinct. Conflating them would make a decision
indistinguishable from an accident.

### 无上游

This one is a promise about what did *not* happen, so it is worth being precise
about. A row is 无上游 only when there is no upstream to compare against: a
directory with no remote, a `@local` package no registry carries, or a project
you muted. It never means "we asked and got nothing back" — a failed request is
检查失败, and it says why.

Getting this right took two tries. Which upstream a row is checked against is
decided by `laneForProject` in `lib/check.mjs`, and the first version read fields
that only the scanner writes (`installed_from`, `updater`). Rows that arrived from
`queue.json` do not have those fields, so every one of them fell through to an
empty probe list and rendered as 无上游 — `DSHgo` and `hyperframes` sat there for
days while their upstreams had four releases and an npm `latest` respectively.
The lesson is in the shape of the mistake: a field written by one source was read
to judge a record written by another. `无上游` is the default that every missed
path lands in, and it looks exactly like "nothing to report", so the lane decision
is a pure function with its own tests rather than a chain of `else if`s.

### 已卸载

An uninstall is a decision about the disk, and the list describes the disk. So a
deleted row is shown for exactly one event: the delete you just performed, in the
page you performed it in. It stays there — crossed out, with the freed size — so
that a working delete and a dead button do not look the same. Close the page and
the name is gone from the session, so the row is gone with it. `watched.json`
still records the deletion; the list just stops answering a question nobody asked.

The record is written before `rm` runs, which means a delete that throws leaves an
entry behind describing something that is still on disk. That entry is rewritten
as `remove-failed` with the error and a freed size of 0, and the page treats only
`removed` as a deletion. Without that split, `github-mcp-server` reported "已卸载
· 释放 25 MB" for a directory that was still there — its `.exe` was held open by a
running MCP child process, so `rm` refused and the claim outlived the failure.

### 有本地补丁

A version number says what upstream called a release; it says nothing about the
files under `node_modules` today. When the installed copy claims a version the
registry publishes, that version's tarball is downloaded once and compared
file-by-file by SHA-256. Every file that differs is named on the row.

This exists because the alternative is two wrong answers: call it "latest" and
the local edits become invisible; call it "modified" and it reads as a problem
needing a fix. Neither is true — the install is current *and* carries deliberate
changes, and the next update will overwrite them.

The comparison only runs where the package manager can produce the published
artifact (`npm`, and local `file:` tarballs). A `github:` or `link:` install has
no registry counterpart — its bytes differ from the tarball by construction, so
the check is skipped instead of reporting every such row as patched.

## GitHub account

The page shows which GitHub account is answering the API calls, and can start a
login without leaving DSH.

Nothing here holds a credential. `gh auth status --json hosts` reports the login,
where the token is stored and its scopes; `gh api rate_limit` reports the quota.
`gh auth token` is deliberately never called — putting a live token into an HTTP
response buys nothing the page needs.

- **Where `gh` comes from.** `DSH_GITHUB_WATCH_GH` → `gh` in `config.json` → PATH
  → `%ProgramFiles%\GitHub CLI\gh.exe`. Missing is a normal state, not a broken
  install: checking for updates works either way (see **About `gh`**), the card
  just cannot name an account.
- **Logging in** spawns `gh auth login --web` and reads the one-time code off its
  output, so the code and `https://github.com/login/device` appear in the page.
  Authorize in the browser and the card flips within a poll or two; **取消** kills
  the child. gh never writes the token to disk itself — it goes to the OS keyring,
  which is why the token never appears in this plugin's state either.
- **Never awaited, cached for 60 s.** Measured here: `gh auth status` 1.44 s and
  `gh api rate_limit` 1.57 s, against 16 ms for everything else in the snapshot.
  gh checks the token against the API inside each call, so neither is local however
  it is spelled. Hence three things:
  - the two calls run **concurrently** (2.9 s → 1.5 s);
  - `GET /api/projects` does **not** wait for them at all. The rows are local files
    and have no business being delayed by a network round trip, so `ghPeek()`
    hands back whatever is cached and refreshes behind the caller's back. The page
    fetches the account separately, paints the rows first and lets the card fill in;
  - a cold cache answers `pending: true`, which is **not** the same as "logged out"
    and is not rendered as such; the page retries a few times until the read lands.

  The memo is dropped when the login child exits, so a successful authorization is
  not masked by a stale "logged out". `POST /api/github/refresh` forces a re-read
  for the case where the user ran `gh auth login` in their own terminal.

Rate limits are the reason all of the above is worth having: see **About `gh`**
below for what each token source buys you.

## Requirements

| | Needed? | Without it |
|---|---|---|
| DSH `>=0.2.1-rc.2 <0.3.0` | required | the plugin does not load |
| Node 18+ | required | ships with DSH, do not install separately |
| `git` on PATH | required | every `git` project says `检查失败`; the rest is unaffected |
| **`gh` (GitHub CLI)** | **recommended, install it yourself** | the account card cannot read a login; **checking for updates is unaffected** |

## About `gh`

`gh` is a separate program, not something bundled here. It is a ~15 MB binary and
it has to follow GitHub's own security releases — vendoring it would only freeze
it at whatever version shipped.

```powershell
winget install --id GitHub.cli     # Windows
```
```bash
brew install gh                    # macOS
```

Then log in once (this needs a browser):

```bash
gh auth login
```

**None of that is needed to check for updates.** The token is looked up in three
places, in order of preference:

1. `GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_PAT` in the environment
2. `gh auth token`
3. `~/.git-credentials` — the file `git` writes itself when you clone over HTTPS

A machine that has ever cloned from GitHub over HTTPS usually already has (3), and
that is a full 5000 requests/hour. What the card cannot tell you in that case is
*who* is logged in — which is the only thing `gh` adds.

The anonymous fallback (nothing found at all) is 60 requests/hour. That is enough
for a handful of projects and not much more, which is why the badge shows the
authenticated number when there is one.

One thing that catches people out: a `gho_` token copied out of `.git-credentials`
cannot be fed to `gh auth login --with-token`. `gh` requires the `read:org` scope,
which those tokens usually lack:

```
error validating token: missing required scope 'read:org'
```

So if you want the card populated, the only route is the browser login above.

Python is **not** required. It is mentioned only where it is relevant: `uv tool`
and `pipx` installs are inspected by reading their metadata off disk, and a
version gate is decided by the interpreter recorded in that venv's `pyvenv.cfg`.

No dependency of ours needs installing. `git` is the one exception, and even it
only degrades a single row: without it the git projects report `检查失败` while
everything else still resolves through the HTTP APIs.

## Tests

```bash
npm test
```

141 tests, no dependencies, no network:

| File | Covers |
|---|---|
| `test/parse.test.mjs` | `parseReport` (every kind, not just the enumerated ones) and `splitBlurb` |
| `test/pipeline.test.mjs` | the inventory and build steps end to end against a fake disk in a temp directory |
| `test/routes.test.mjs` | the HTTP endpoints, including that the page paints before the GitHub account has been read |
| `test/render.test.mjs` | headless renders of `client.js`, so a broken hook order fails here instead of showing a blank page. Also: an uninstalled row is gone when the page is reopened, stays on screen for the session that deleted it, and a patched install gets its own status class |
| `test/check.test.mjs` | `probeGit` resolves the default branch instead of assuming `main`, recovers from a stale remembered branch, and never reports a failure with nothing after the colon; `cacheStillDescribes` compares the bare local version rather than the `本地 → 上游` display line, which is the difference between a six-hour cache that works and one that never once hit; `laneForProject` keeps asking upstream about rows that arrived from `queue.json` and not only about rows the scanner recognised; and `versionKey` reads the version out of `v1.3` and `hyperframes@0.9.7 (npx)` instead of calling both of them zero |
| `test/summary.test.mjs` | `summarizeRelease`: a hard-wrapped English note is joined into paragraphs before it is summarised, sections that are not changes are dropped, a period inside `v0.2.2` or `check.mjs` is not read as a sentence end, and nothing is truncated by length |
| `test/guard.test.mjs` | every write endpoint refuses a request without the marker header, from a foreign origin, or with a non-JSON body |
| `test/safety.test.mjs` | `isSafePath`: `..` never escapes, a scan root itself is never deletable, and every root the scanner walks is reachable by the delete guard. `uninstalledBySlug`: a `remove-failed` attempt is kept on record but is never read back as a completed uninstall |
| `test/body.test.mjs` | `readJsonBody`: an oversized body is refused instead of hanging the request |
| `test/util.test.mjs` | `writeJson` is atomic — a reader never sees half a file |
| `test/size.test.mjs` | `dirSize` is bounded and says when it truncated |
| `test/fetch.test.mjs` | upstream responses are capped in bytes, including when the server lies about the length |
| `test/kill.test.mjs` | a timed-out command takes its whole process tree down, detached grandchildren included |
| `test/npm.test.mjs` | `slugFromRepository` across the shapes npm allows, and that the npm probe asks for one version instead of the full packument |
| `test/patch.test.mjs` | `patch.mjs` against tarballs built byte by byte in the test: a long path survives the GNU longname record, an identical tree is not patched, one edited file is named, and a file only the install has does not by itself mean patched |
| `test/scan.test.mjs` | `stepArgs`: the button's `check` step carries `--force` while `inventory`/`build` never do, because only one of the three has a cache to skip — and the step name is never dropped from argv |

They never touch `~/.dsh-github-watch`: helper `isolate()` points
`DSH_GITHUB_WATCH_DIR` at a fresh temp directory before the step modules are
imported, which matters because those modules create the directory at import
time.

CI runs the same command on `windows-latest` against Node 18/20/22/24.

## Platforms

Windows only, and the CI matrix says so. The scanner hard-codes Windows
locations by design: `%APPDATA%\npm` for global packages, `%LOCALAPPDATA%\pipx`
and `%LOCALAPPDATA%\Programs` for stores and downloaded binaries, `uv.exe` under
`%APPDATA%\uv\tools`, and `C:\Program Files\GitHub CLI\gh.exe` as the last
resort for `gh`. On macOS or Linux those lookups find nothing, so you get an
empty list rather than a wrong one — but "empty" is not what you installed it
for.

## License

MIT
