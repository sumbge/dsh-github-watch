"""Turn the scan into the registry the Settings page reads.

The machine-specific version of this file carried a hand-written PROJECTS list
with every project's absolute path. That cannot ship: on another machine those
paths do not exist, and the page would be a list of dead links.

So the rule here is the inverse — the scan decides what is listed, and the only
hand-maintained file is optional *overrides* (`registry.json`) used to add a
note, alias, dependency or work directory to a row the scan already found.

Inputs:
  local_inventory.json   written by inventory_local.py
  registry.json          optional; {"notes": {...}, "deps": {...}, ...}

Output:
  inventory.json         read by the plugin
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _config import watch_dir

WATCH = watch_dir()


def version_key_for_sort(v: str) -> tuple:
    """Sort key for "which copy is newer".

    An empty or unparseable version yields a tuple that sorts BELOW any real
    version, so a checkout with no version never displaces a released one.
    """
    text = str(v or "").strip()
    if not text:
        return (-1,)
    parts = re.split(r"[.\-+]", text)[:4]
    out = []
    for part in parts:
        out.append(int(part) if part.isdigit() else 0)
    return tuple(out) if out else (-1,)
SRC = os.path.join(WATCH, "local_inventory.json")
OUT = os.path.join(WATCH, "inventory.json")
OVERRIDES = os.path.join(WATCH, "registry.json")


def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def dir_mb(path, include_deps=False):
    total = 0
    for dirpath, dirnames, filenames in os.walk(path):
        if not include_deps:
            dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
        for name in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                pass
    return round(total / 1048576, 1)


def main() -> int:
    scan = load(SRC)
    if not scan:
        print(f"缺少 {SRC}，先跑 inventory_local.py", file=sys.stderr)
        return 2

    ov = load(OVERRIDES, {}) or {}
    notes = ov.get("notes") or {}
    aliases = ov.get("aliases") or {}
    deps = ov.get("deps") or {}
    works = ov.get("work") or {}
    muted_keep = {}

    # Preserve mute flags from the previous build: muting is a decision, and the
    # scanner cannot derive it. Without this a rebuild silently un-mutes
    # everything the operator parked.
    previous = load(OUT, {}) or {}
    for row in (previous.get("projects") or []) + (previous.get("plugins") or []):
        if row.get("muted") and row.get("name"):
            muted_keep[row["name"]] = True

    names = ov.get("names") or {}
    skip = set(ov.get("skip") or [])
    # A path the operator named in registry.json is also the path they chose to
    # keep when a repo is cloned twice. Without this, dedupe picked whichever
    # clone the scan happened to return first — and the stale copy under
    # Documents shadowed the live one under Desktop.
    preferred = set(names) | set(ov.get("notes") or {}) | set(ov.get("deps") or {})

    # One row per upstream, not per clone: a second checkout of the same remote
    # is an alias, and listing it separately makes the same repo appear twice
    # with two different sizes. Which clone survives matters — the operator's
    # registry.json picks it when they named a path, otherwise the shallowest.
    names = ov.get("names") or {}
    preferred = set(names) | set(ov.get("notes") or {}) | set(ov.get("deps") or {})

    def keep_rank(p, idx):
        """Lower sorts earlier. Named-by-operator beats shallow beats scan order."""
        named = 0 if p.get("path") in preferred else 1
        return (named, p.get("depth") or 99, idx)

    chosen = {}
    for idx, p in enumerate(scan.get("projects", [])):
        path = p.get("path", "")
        if path in skip:
            continue
        remote = (p.get("remote") or "").strip().lower()
        key = remote or f"path:{path}"
        cand = chosen.get(key)
        if cand is None or keep_rank(p, idx) < keep_rank(cand[1], cand[0]):
            chosen[key] = (idx, p)

    winners = sorted(chosen.values(), key=lambda t: t[0])

    projects = []
    for _, p in winners:
        path = p.get("path", "")
        # The scan guesses a name from the directory; the operator may know
        # better (a repo cloned into `rea-agents/` is still "rea"). Overrides
        # win, keyed by path so a rename survives a rescan.
        fallback = os.path.basename(path.rstrip("\\/")) or "?"
        entry = {
            "name": names.get(path) or p.get("name") or fallback,
            "kind": "git" if p.get("has_git") else "dir",
            "slug": p.get("remote") or "",
            "path": path,
            "exists": os.path.isdir(path),
            "version": p.get("version") or "",
            "size_mb": 0.0,   # filled in below; the scan's number excludes node_modules
            "note": notes.get(path, ""),
            "aliases_present": aliases.get(path, []),
            "deps": deps.get(path, []),
            "work": works.get(path),
        }
        # Three numbers, because the page answers three different questions:
        #   own_mb  — this project's own bytes on disk (node_modules included:
        #             rea is 535 MB, of which 442 MB is node_modules)
        #   deps_mb — the dependencies listed under it
        #   size_mb — own + deps, the total a reader sees first. Keeping it as
        #             the sum is what makes "rea 2.9 GB" honest: the project is
        #             535 MB, and the toolchain it needs is another 2.4 GB.
        own = dir_mb(path, include_deps=True) if os.path.isdir(path) else (p.get("size_mb") or 0.0)
        entry["own_mb"] = own
        entry["deps_mb"] = round(sum(d.get("size_mb", 0) for d in entry["deps"]), 1)
        entry["size_mb"] = round(own + entry["deps_mb"], 1)
        # The plugin reads this to decide whether a delete would destroy the
        # operator's own output, so it has to be a number even when there is no
        # work directory — `None` would make `workMb > 0` false in JS but also
        # feed "undefined MB" into the confirm dialog.
        work = entry["work"]
        entry["work_mb"] = round(float(work.get("size_mb") or 0), 1) if work else 0.0
        if work and not work.get("size_mb"):
            total = sum(item.get("size_mb", 0) for item in work.get("items", []))
            entry["work_mb"] = round(total, 1)
        if muted_keep.get(entry["name"]):
            entry["muted"] = True
        projects.append(entry)

    # Projects the scan cannot find: a Release tarball unpacked outside the
    # scanned roots, a repo whose layout does not look like a checkout. They are
    # declared in registry.json rather than inferred, because guessing whether a
    # directory is a project is how the scan ends up listing 40 build submodules.
    for extra in ov.get("extra_projects") or []:
        path = extra.get("path", "")
        if not path or path in skip:
            continue
        own = dir_mb(path, include_deps=True) if os.path.isdir(path) else 0.0
        deps_list = deps.get(path, [])
        entry = {
            "name": extra.get("name") or os.path.basename(path.rstrip("\\/")),
            "kind": extra.get("kind") or "dir",
            "slug": extra.get("slug") or "",
            "path": path,
            "exists": os.path.isdir(path),
            "version": extra.get("version") or "",
            "note": extra.get("note") or notes.get(path, ""),
            "aliases_present": aliases.get(path, []),
            "deps": deps_list,
            "work": works.get(path),
            "own_mb": own,
            "deps_mb": round(sum(d.get("size_mb", 0) for d in deps_list), 1),
            "size_mb": round(own + sum(d.get("size_mb", 0) for d in deps_list), 1),
            "work_mb": 0.0,
        }
        if muted_keep.get(entry["name"]):
            entry["muted"] = True
        projects.append(entry)

    # One row per plugin, not one row per directory. The same package is often on
    # disk several times — the profile's node_modules (the install actually in
    # use), a working checkout, a stray clone from some agent — and the copies
    # drift in version. A row per directory re-asks "which one is real?" for every
    # duplicate, so keep the newest and record the rest as copies on that row.
    raw = []
    for p in scan.get("plugins", []):
        raw.append({
            "name": p.get("name") or "",
            "slug": p.get("remote") or "",
            "version": p.get("version") or "",
            "install_path": p.get("path", ""),
            "profile": p.get("profile", ""),
            "installed": True,
            "note": notes.get(p.get("path", ""), ""),
        })

    grouped: dict[str, list[dict]] = {}
    for entry in raw:
        grouped.setdefault(entry["name"], []).append(entry)

    plugins = []
    for name, entries in grouped.items():
        keyed = [(version_key_for_sort(e["version"]), idx, e) for idx, e in enumerate(entries)]
        best_key = max(k for k, _, _ in keyed)
        # Among equals, the profile install wins: that is the copy the host loads.
        primary = next(
            (e for k, _, e in keyed if k == best_key and e["profile"] == "desktop"),
            next(e for k, _, e in keyed if k == best_key),
        )
        copies = [e for e in entries if e is not primary]
        merged = dict(primary)
        if copies:
            merged["copies"] = [
                {"path": c["install_path"], "version": c["version"], "profile": c["profile"]}
                for c in sorted(copies, key=lambda x: version_key_for_sort(x["version"]), reverse=True)
            ]
        if muted_keep.get(merged["name"]):
            merged["muted"] = True
        plugins.append(merged)

    plugins.sort(key=lambda p: (p["name"] or "").lower())

    # Standalone binaries are not packages, so no scan finds them: they are
    # declared. Each is checked for existence and its version read from the file,
    # because the page's job is "what do I have", not "what is in node_modules".
    tools = []
    for t in ov.get("tools") or []:
        path = t.get("path", "")
        exists = bool(path) and os.path.isfile(path)
        tools.append({
            "name": t.get("name", ""),
            "slug": t.get("slug", ""),
            "version": t.get("version", ""),
            "path": path,
            "why": t.get("why", ""),
            "exists": exists,
            "size_mb": round(os.path.getsize(path) / 1048576, 1) if exists else 0.0,
        })

    # Anything the scan found that neither a curated row nor an override
    # mentions. With no hand-written registry there is no "curated" baseline,
    # so the honest definition is: a project the operator has not annotated —
    # i.e. one they may not know about. That is the whole point of the
    # section: it catches a download nobody logged.
    known = set(ov.get("names") or {}) | set(ov.get("notes") or {}) | set(ov.get("deps") or {})
    listed_paths = {p["path"] for p in projects}
    discovered = []
    for p in scan.get("projects", []):
        path = p.get("path", "")
        if path in known or path in skip or path in listed_paths:
            continue
        discovered.append({
            "name": p.get("name") or os.path.basename(path.rstrip("\\/")),
            "slug": p.get("remote") or "",
            "path": path,
            "kind": "git" if p.get("has_git") else "dir",
            "sizeMb": p.get("size_mb") or dir_mb(path),
            "description": (p.get("description") or "")[:160],
        })

    data = {
        "projects": projects,
        "plugins": plugins,
        "tools": tools,
        "discovered": discovered,
        "scanned_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "generated_from": "local_inventory.json",
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)

    print(f"项目 {len(projects)} 个，插件 {len(plugins)} 个，工具 {len(tools)} 个 -> {OUT}")
    if discovered:
        print(f"未标注 {len(discovered)} 个（在 registry.json 里加一条就进主列表）:")
        for d in discovered[:10]:
            print(f"  {d['name']:28} {d['slug'] or '-':32}{d['sizeMb']:>8} MB")
    for p in projects:
        mark = "" if p["exists"] else "  [!] path missing"
        print(f"  {p['name']:28} {p['kind']:5} {p['slug'] or '-':34}{p['size_mb']:>9} MB{mark}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
