# dsh-github-watch

A DeepSeek Harness plugin that answers one question honestly: **what GitHub projects are on this machine, and which of them are behind upstream?**

Adds a Settings page (设置 → 已下载项目) listing every tracked repo with its size, dependencies, upstream status and last check, and lets you update, mute or delete them from there.

## What it does

| | |
|---|---|
| **Tabs** | 项目 / 插件 / 已屏蔽 — side by side, no scrolling |
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
- **Record before delete.** `watched.json` gets a `removed` entry first, so a delete that fails halfway still leaves evidence of intent.
- **Mute is not hide.** A muted project stays in its own tab. Hiding it would make "I muted it" and "it vanished" look identical.

## What the statuses mean

| Status | Meaning |
|---|---|
| 有更新 | Local HEAD differs from upstream — `git pull` applies |
| 上游有新版 | No `.git` to diff; date comparison only. **Not** proof the local copy can be updated |
| 上游有新提交 | Same, for snapshot projects |
| 上游已下架 | The package no longer exists upstream |
| 受 Python 版本限制 | Newer versions exist but require a Python the tool's venv does not have |
| 已屏蔽 | You muted it; it is not checked |
| 已卸载 | You deleted it; recorded in `watched.json` |
| 目录不见了 | Gone from disk with no removal record — someone else deleted it, or it moved |

The last two are deliberately distinct. Conflating them would make a decision
indistinguishable from an accident.

## GitHub account

The page shows which GitHub account is answering the API calls, and can start a
login without leaving DSH.

Nothing here holds a credential. `gh auth status --json hosts` reports the login,
where the token is stored and its scopes; `gh api rate_limit` reports the quota.
`gh auth token` is deliberately never called — putting a live token into an HTTP
response buys nothing the page needs.

- **Where `gh` comes from.** `DSH_GITHUB_WATCH_GH` → `gh` in `config.json` → PATH
  → `%ProgramFiles%\GitHub CLI\gh.exe`. Missing is a normal state: the rest of the
  page works, the account card just says so.
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

Rate limit matters here specifically: anonymous GitHub API is 60 requests/hour,
while the badge shows the authenticated 5000. Without a login the checks work but
run out fast.

## Requirements

- DSH `>=0.2.1-rc.2 <0.3.0`
- Node 18+ (uses `fetch`, `node:test`-free but modern stdlib)
- `git` on PATH — for `ls-remote` and `pull`
- `gh` on PATH — optional, only for the account card and the quota badge

Python is **not** required. It is mentioned only where it is relevant: `uv tool`
and `pipx` installs are inspected by reading their metadata off disk, and a
version gate is decided by the interpreter recorded in that venv's `pyvenv.cfg`.

## License

MIT
