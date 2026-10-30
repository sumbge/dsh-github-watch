# Scanner scripts

Three Python scripts that produce the files the Settings page reads. They are
optional — the plugin works with any `inventory.json` — but writing this by hand
is tedious, so they are here.

## Setup

```bash
pip install -r requirements.txt   # nothing: stdlib only, Python 3.9+
mkdir ~/.dsh-github-watch
```

Tell it where your projects are, either way:

```bash
# option A — environment
export DSH_GITHUB_WATCH_DIR=~/.dsh-github-watch
export DSH_GITHUB_WATCH_ROOTS="D:\code;/home/me/src"
```

```json
// option B — config.json next to the plugin's index.js
{ "watchDir": "/home/me/.dsh-github-watch",
  "roots": ["D:\\code", "/home/me/src"] }
```

With no roots declared it scans `~/Desktop`, `~/Documents` and `~/Downloads`,
which is where most people clone.

## Run

```bash
python inventory_local.py    # walk the disk -> local_inventory.json
python build_inventory.py    # merge with registry.json -> inventory.json
python check.py              # query upstreams -> report.md
```

Run them in that order. Each reads the previous one's output.

## What ends up where

```
<watchDir>/
  local_inventory.json   raw scan: every candidate directory it found
  inventory.json         what the page shows
  report.md              upstream status
  registry.json          your annotations (optional, see below)
  state.json             last-seen commits, so "has an update" is a diff not a guess
```

## registry.json — the only file you edit by hand

The scan decides what gets listed. `registry.json` only annotates rows it
already found, so a fresh machine works with no curation at all:

```json
{
  "names": {
    "D:\\code\\rea-agents": "rea"
  },
  "notes": {
    "D:\\code\\autoforge-clean": "只保留这份，Documents 下那份是旧副本"
  },
  "aliases": {
    "D:\\code\\autoforge-clean": ["D:\\code\\autoforge"]
  },
  "skip": ["D:\\code\\autoforge"],
  "deps": {
    "D:\\code\\rea": [
      { "name": "Ghidra", "path": "D:\\tools\\ghidra", "size_mb": 863.9,
        "why": "反编译后端", "local": false }
    ]
  },
  "work": {
    "D:\\code\\rea": { "path": "D:\\code\\rea\\recon",
                      "why": "逆向作业产出，删了无法恢复" }
  },
  "tools": [
    { "name": "uv", "path": "D:\\tools\\uv.exe", "slug": "astral-sh/uv",
      "version": "0.12.3", "why": "Python 包管理" }
  ],
  "extra_projects": [
    { "name": "github-mcp-server", "kind": "snapshot",
      "slug": "github/github-mcp-server", "path": "D:\\mcp\\github-mcp-server",
      "version": "1.12.0", "note": "解压的发布包，没有 .git" }
  ]
}
```

| key | purpose |
|---|---|
| `names` | override a scanned name (directory name ≠ project name) |
| `notes` | one line shown under the row |
| `aliases` | other clones of the same repo, shown as "also cloned at" |
| `skip` | paths to ignore entirely (stale duplicates, dependency checkouts) |
| `deps` | things a project needs but did not install itself |
| `work` | output you produced — the part a delete cannot recover |
| `tools` | standalone binaries; nothing scans for these |
| `extra_projects` | projects the scan misses (unpacked tarballs, odd layouts) |

Everything here is optional. Without it you get a flat list of what is on disk
with upstream status — which is most of the value.

## Two sizes, and why

`size_mb` is `own_mb + deps_mb`. The page is answering "how much does this cost me
in total", so a project that is 535 MB but needs a 2.4 GB toolchain reads as
2.9 GB. `own_mb` is the directory itself, dependencies included — rea is 535 MB
on disk because 442 MB of it is `node_modules`.

## Token

`check.py` uses `GITHUB_TOKEN` / `GH_TOKEN` if set (5000 req/h), and falls back to
unauthenticated GitHub API (60 req/h). When the quota runs out it says so rather
than reporting every row as failed.