# dsh-github-watch

A DeepSeek Harness plugin that answers one question honestly: **what GitHub projects are on this machine, and which of them are behind upstream?**

Adds a Settings page (设置 → 已下载项目) listing every tracked repo with its size, dependencies, upstream status and last check, and lets you update, mute or delete them from there.

## What it does

| | |
|---|---|
| **Tabs** | 项目 / 插件 / 工具 / 已屏蔽 — side by side, no scrolling |
| **Sizes** | Per project, showing the project separate from its dependencies and from work output you produced |
| **Upstream** | `git ls-remote` for clones, GitHub API for snapshots, `npm view` for plugins |
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

## Get data into it

The plugin is only the view. The files it reads are produced by three Python
scripts bundled under `scripts/` — see [scripts/README.md](scripts/README.md) for
the full guide.

```bash
cd <profile>/node_modules/dsh-github-watch/scripts
python inventory_local.py     # walk the disk
python build_inventory.py     # merge with registry.json
python check.py               # query upstreams
```

Then point the plugin at the directory those wrote:

```bash
export DSH_GITHUB_WATCH_DIR=~/.dsh-github-watch     # or put it in config.json
```

With nothing configured, the scripts scan `~/Desktop`, `~/Documents` and
`~/Downloads`, which is where most people clone. `registry.json` (optional, and
gitignored) is where you add names, notes, dependencies and work directories.

**A fresh install shows an empty page until a scan has run.** That is not a bug:
there is nothing to show yet.

## Safety

Deletion is real (`rm -rf`), so it is guarded:

- **Two steps.** The confirm dialog names the three kinds of bytes separately — re-downloadable, edited locally, and work output you cannot get back. A single "delete 3.2 GB" hides the only part that matters.
- **Path allowlist.** `~/Desktop`, `~/Documents`, `~/Downloads`, plus any roots in `DSH_GITHUB_WATCH_ROOTS` — and, for plugins, a package directory directly inside a DSH profile's `node_modules`. A malformed path in `inventory.json` cannot become `Remove-Item C:\`.
- **Record before delete.** `watched.json` gets a `removed` entry first, so a delete that fails halfway still leaves evidence of intent.
- **Mute is not hide.** A muted project stays in its own tab. Hiding it would make "I muted it" and "it vanished" look identical.

## What the statuses mean

| Status | Meaning |
|---|---|
| 有更新 | Local HEAD differs from upstream — `git pull` applies |
| 上游有新版 | No `.git` to diff; date comparison only. **Not** proof the local copy can be updated |
| 上游有新提交 | Same, for snapshot projects |
| 上游已下架 | The package no longer exists upstream |
| 已屏蔽 | You muted it; it is not checked |
| 已卸载 | You deleted it; recorded in `watched.json` |
| 目录不见了 | Gone from disk with no removal record — someone else deleted it, or it moved |

The last two are deliberately distinct. Conflating them would make a decision
indistinguishable from an accident.

## Requirements

- DSH `>=0.2.1-rc.2 <0.3.0`
- Node 20+
- Python 3.9+ (only for the bundled scan scripts)
- `git` on PATH

## License

MIT