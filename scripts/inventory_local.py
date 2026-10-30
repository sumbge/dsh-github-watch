"""Inventory every project currently on this machine, split into projects vs plugins.

The question is "what is on disk now", not "what did I clone". A repo arrives by
clone, by zip download, by Release asset, or by an installer — only the first
leaves a trace in a shell transcript. So this walks the disk first and classifies
afterwards, instead of starting from command history.

Two buckets:
  project — source you obtained and keep: a git repo, or a directory that looks
            like a checkout (has README/package.json/pyproject and its own dir)
  plugin  — a package installed *into* a host (DSH profile node_modules, or a
            directory whose manifest declares a dsh bundle/plugin)

Excluded on purpose: another tool's cache (Codex plugins/cache, vendor_imports,
marketplaces) — those are not things the operator obtained.

Run: python inventory_local.py
"""
from __future__ import annotations

import json
import os
import re
import time

import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Paths come from _config so the same script runs on any machine: the data
# directory, the roots to walk, and the profile node_modules are discovered
# or declared rather than written down.
from _config import watch_dir, roots as _config_roots, profile_node_modules

WATCH = watch_dir()
OUT = os.path.join(WATCH, "local_inventory.json")

PROFILE_NM = glob_dirs = profile_node_modules()

ROOTS = _config_roots()

PRUNE = {
    "node_modules", ".git", "__pycache__", "AppData", ".cache", ".codex",
    ".trae-cn", ".workbuddy", ".codebuddy", ".claude", ".qoder", "dist",
    "build", "target", ".venv", "venv", "__snapshots__",
}

CACHE_MARKERS = ("\\plugins\\cache\\", "\\vendor_imports\\", "\\marketplaces\\",
                 "\\connectors-marketplace\\")

# A directory counts as a project root only if it is one of:
#   * a git checkout (has .git)
#   * a top-level folder under a root that carries its own manifest AND source
# The earlier test — "has README.md or package.json" — turned Ghidra's 40 feature
# submodules into 40 projects, because each ships a build.gradle and a README.
# A submodule of a project is not a project.
PROJECT_MARKERS = ("package.json", "pyproject.toml", "Cargo.toml", "go.mod",
                   "pom.xml", "setup.py", "build.gradle", "SKILL.md")
SOURCE_DIRS = ("src", "lib", "app", "scripts", "packages", "bin")

GH_REMOTE = re.compile(r"url\s*=\s*\S*github\.com[/:]([\w.-]+/[\w.-]+?)(?:\.git)?\s*$", re.MULTILINE)

# Directories people conventionally keep checkouts in. Depth costs nothing to
# ignore here because a walk stops at the first `.git` it meets, so a deep
# `~/code/...` tree costs the same as a shallow one.
PROJECT_PARENTS = frozenset({
    "projects", "project", "repos", "repositories", "repo", "src", "source",
    "code", "dev", "develop", "git", "github", "gitlab", "checkouts", "checkout",
    "workspace", "workspaces", "work", "ai", "tools", "plugins", "skills",
    "agents", "sandbox", "playground", "experiments",
})

# Cost guards. A walk that trips either one returns what it found so far, so a
# user who points this at a whole drive gets a partial answer instead of a hang.
MAX_DIRS = 60000
MAX_SECONDS = 45.0


def depth_budget(dirname: str, default: int) -> int | None:
    """How deep to keep walking from here. None means "no limit".

    The default depth is a fallback for ordinary folders; a conventional
    project parent is allowed to run deep because the `.git` stop makes depth
    the wrong thing to bound.
    """
    if dirname.lower() in PROJECT_PARENTS:
        return None
    return default



def git_remote(path: str) -> str:
    cfg = os.path.join(path, ".git", "config")
    if not os.path.isfile(cfg):
        return ""
    try:
        with open(cfg, "r", encoding="utf-8", errors="replace") as fh:
            m = GH_REMOTE.search(fh.read())
        return m.group(1) if m else ""
    except OSError:
        return ""


def manifest_info(path: str) -> dict:
    """name/description/version from package.json or pyproject, if present."""
    pj = os.path.join(path, "package.json")
    if os.path.isfile(pj):
        try:
            with open(pj, "r", encoding="utf-8", errors="replace") as fh:
                d = json.load(fh)
            repo = d.get("repository")
            url = repo if isinstance(repo, str) else (repo or {}).get("url", "")
            m = re.search(r"github\.com[/:]([\w.-]+/[\w.-]+?)(?:\.git)?$", str(url).strip())
            return {
                "name": d.get("name") or "",
                "version": d.get("version") or "",
                "description": (d.get("description") or "")[:200],
                "repo": m.group(1) if m else "",
                "is_dsh_plugin": bool((d.get("dsh") or {}).get("bundle") or (d.get("dsh") or {}).get("client")),
            }
        except Exception:                            # noqa: BLE001
            pass
    py = os.path.join(path, "pyproject.toml")
    if os.path.isfile(py):
        try:
            with open(py, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            name = re.search(r'^name\s*=\s*["\']([^"\']+)', text, re.M)
            ver = re.search(r'^version\s*=\s*["\']([^"\']+)', text, re.M)
            desc = re.search(r'^description\s*=\s*["\']([^"\']+)', text, re.M)
            return {
                "name": name.group(1) if name else "",
                "version": ver.group(1) if ver else "",
                "description": (desc.group(1)[:200] if desc else ""),
                "repo": "",
                "is_dsh_plugin": False,
            }
        except OSError:
            pass
    return {"name": "", "version": "", "description": "", "repo": "", "is_dsh_plugin": False}


def dir_size_mb(path: str, cap_files: int = 4000) -> float:
    total = 0
    seen = 0
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
        for f in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
            seen += 1
            if seen >= cap_files:
                return round(total / 1048576, 1)
    return round(total / 1048576, 1)


def walk_projects() -> list[dict]:
    found = []
    visited = 0
    started = time.monotonic()
    for root, max_depth in ROOTS:
        if not os.path.isdir(root):
            continue
        base = root.rstrip("\\").count("\\")
        for dirpath, dirnames, filenames in os.walk(root):
            visited += 1
            # Cost is bounded by work done, not by a depth the user has to guess:
            # hitting either limit returns what was found so far instead of hanging.
            if visited > MAX_DIRS or time.monotonic() - started > MAX_SECONDS:
                print(f"  (预算用尽: {visited} 目录 / {time.monotonic() - started:.0f}s，先返回已找到的)")
                return _outermost(found)
            depth = dirpath.count("\\") - base
            low = dirpath.lower()
            has_git = os.path.isdir(os.path.join(dirpath, ".git"))
            marks = [m for m in PROJECT_MARKERS if m in filenames]

            # Qualify on git, or on a manifest *plus* a source directory: an
            # installed application carries manifests in every subdirectory, but
            # only a project has its own source tree beside them.
            has_source = any(d in dirnames for d in SOURCE_DIRS)
            qualifies = has_git or (bool(marks) and has_source and depth <= 2)

            # A repository root is the answer: stop descending immediately so the
            # depth limit stops mattering. Without this, `depth 5` had to be
            # guessed precisely — one level too shallow silently dropped projects,
            # and every level deeper meant walking node_modules and .venv trees.
            if has_git:
                if not any(c in low for c in CACHE_MARKERS):
                    found.append({
                        "path": dirpath,
                        "has_git": True,
                        "remote": git_remote(dirpath),
                        **manifest_info(dirpath),
                        "depth": depth,
                    })
                dirnames[:] = []
                continue

            budget = depth_budget(os.path.basename(dirpath), max_depth)
            if budget is not None and depth >= budget:
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames if d not in PRUNE]

            if qualifies and depth > 0 and not any(c in low for c in CACHE_MARKERS):
                found.append({
                    "path": dirpath,
                    "has_git": has_git,
                    "remote": git_remote(dirpath),
                    **manifest_info(dirpath),
                    "depth": depth,
                })

    return _outermost(found)


def _outermost(found: list[dict]) -> list[dict]:
    """Keep the outermost of any nested group: a repo's own subfolders that happen
    to qualify are not separate projects."""
    found.sort(key=lambda p: p["path"].count("\\"))
    kept = []
    for p in found:
        if any(p["path"].lower().startswith(k["path"].lower() + "\\") for k in kept):
            continue
        kept.append(p)
    return kept


def plugin_packages() -> list[dict]:
    out = []
    for nm in PROFILE_NM:
        if not os.path.isdir(nm):
            continue
        for entry in os.listdir(nm):
            candidates = []
            full = os.path.join(nm, entry)
            if entry.startswith("@"):
                for sub in os.listdir(full):
                    candidates.append(os.path.join(full, sub))
            elif os.path.isdir(full):
                candidates.append(full)
            for c in candidates:
                info = manifest_info(c)
                if not os.path.isfile(os.path.join(c, "package.json")):
                    continue
                try:
                    with open(os.path.join(c, "package.json"), "r", encoding="utf-8", errors="replace") as fh:
                        d = json.load(fh)
                except Exception:                    # noqa: BLE001
                    continue
                dsh = d.get("dsh") or {}
                if not (dsh.get("bundle") or dsh.get("client")):
                    continue
                out.append({
                    "path": c,
                    "profile": "desktop" if "desktop" in nm else "web",
                    "name": d.get("name") or entry,
                    "version": d.get("version") or "",
                    "description": (d.get("description") or "")[:200],
                    "repo": info["repo"],
                    "link": os.path.islink(c),
                })
    return out


# Package-manager installs that live outside the scan roots. `uv tool`, `pipx`
# and `npm -g` all drop a directory under AppData/Local or AppData/Roaming, which
# the walk prunes on purpose — those trees are enormous and mostly cache. But the
# *installed tools* in them were obtained by the operator and deserve a row, so
# they are looked up directly at their known locations instead of by walking.
def tool_installs() -> list[dict]:
    out: list[dict] = []
    home = os.path.expanduser("~")
    appdata = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
    localappdata = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")

    def add(path: str, manager: str, name: str, version: str, repo: str) -> None:
        out.append({
            "path": path,
            "profile": manager,
            "name": name,
            "version": version,
            "description": "",
            "repo": repo,
            "link": False,
            "is_tool": True,
        })

    # uv tool: <Roaming>/uv/tools/<name>/uv-receipt.toml names the package but
    # records neither version nor source, so the version comes from the venv's
    # dist-info and the source from PyPI's project metadata.
    uv_root = os.path.join(appdata, "uv", "tools")
    if os.path.isdir(uv_root):
        for entry in sorted(os.listdir(uv_root)):
            full = os.path.join(uv_root, entry)
            receipt = os.path.join(full, "uv-receipt.toml")
            if not os.path.isfile(receipt):
                continue
            name, version, repo = entry, "", ""
            try:
                with open(receipt, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
                m = re.search(r'name\s*=\s*"([^"]+)"', text)
                if m:
                    name = m.group(1)
                m = re.search(r'github\.com[/:]([\w.-]+/[\w.-]+?)(?:\.git)?["\s]', text)
                if m:
                    repo = m.group(1)
            except OSError:
                pass

            # Version lives next to the installed package, not in the receipt.
            site = os.path.join(full, "Lib", "site-packages")
            if os.path.isdir(site):
                try:
                    for dist in sorted(os.listdir(site)):
                        if not dist.endswith(".dist-info"):
                            continue
                        stem = dist[: -len(".dist-info")]
                        pkg, _, ver = stem.rpartition("-")
                        if pkg.replace("_", "-").lower() == name.replace("_", "-").lower():
                            version = ver
                            break
                except OSError:
                    pass

            add(full, "uv tool", name, version, repo)

    # pipx: <Local>/pipx/venvs/<name>/  — the version is in the dist-info dir.
    pipx_root = os.path.join(localappdata, "pipx", "venvs")
    if os.path.isdir(pipx_root):
        for entry in sorted(os.listdir(pipx_root)):
            full = os.path.join(pipx_root, entry)
            site = os.path.join(full, "Lib", "site-packages")
            version, repo = "", ""
            if os.path.isdir(site):
                for dist in sorted(os.listdir(site)):
                    if dist.endswith(".dist-info"):
                        stem = dist[: -len(".dist-info")]
                        if "-" in stem:
                            version = stem.rsplit("-", 1)[1]
                        meta = os.path.join(site, dist, "METADATA")
                        try:
                            with open(meta, "r", encoding="utf-8", errors="replace") as fh:
                                m = re.search(r'github\.com[/:]([\w.-]+/[\w.-]+?)(?:\.git)?\s*$',
                                              fh.read(), re.MULTILINE)
                            if m:
                                repo = m.group(1)
                        except OSError:
                            pass
                        break
            add(full, "pipx", entry, version, repo)

    # npm -g: <Roaming>/npm/node_modules/<pkg>/
    npm_root = os.path.join(appdata, "npm", "node_modules")
    if os.path.isdir(npm_root):
        cands = []
        for entry in sorted(os.listdir(npm_root)):
            full = os.path.join(npm_root, entry)
            if entry.startswith("@"):
                try:
                    for sub in sorted(os.listdir(full)):
                        cands.append(os.path.join(full, sub))
                except OSError:
                    continue
            elif os.path.isdir(full):
                cands.append(full)
        for c in cands:
            pj = os.path.join(c, "package.json")
            if not os.path.isfile(pj):
                continue
            try:
                with open(pj, "r", encoding="utf-8", errors="replace") as fh:
                    d = json.load(fh)
            except (OSError, ValueError):
                continue
            repo = d.get("repository")
            url = repo if isinstance(repo, str) else (repo or {}).get("url", "")
            m = re.search(r"github\.com[/:]([\w.-]+/[\w.-]+?)(?:\.git)?$", str(url).strip())
            add(c, "npm -g", d.get("name") or os.path.basename(c),
                d.get("version") or "", m.group(1) if m else "")

    return out


def main() -> int:
    print("扫描本地项目…")
    projects = walk_projects()
    print(f"  {len(projects)} 个候选目录")

    plugins = plugin_packages()
    print(f"DSH 插件（profile node_modules 里声明 dsh.bundle/client 的）: {len(plugins)} 个")

    tools_found = tool_installs()
    print(f"包管理器装的工具（uv tool / pipx / npm -g）: {len(tools_found)} 个\n")

    for p in projects:
        p["size_mb"] = dir_size_mb(p["path"])

    # Reclassify. A directory whose own manifest declares dsh.bundle / dsh.client
    # IS a plugin, wherever it sits on disk: dsh-agent-autoforge lives in
    # Desktop\dsh as a working copy and was being counted as a project.
    # `_dsh_unpacked` is an unpacked copy of the app itself, not something
    # obtained; empty stubs are not projects either.
    moved = []
    for p in projects:
        if p.get("is_dsh_plugin"):
            plugins.append({
                "path": p["path"], "profile": "local checkout",
                "name": p.get("name") or os.path.basename(p["path"]),
                "version": p.get("version") or "",
                "description": p.get("description") or "",
                "repo": p.get("remote") or p.get("repo") or "",
                "link": False,
            })
            moved.append(p["path"])
    # Keep every real project. An earlier version also required size_mb > 0.05,
    # which silently dropped genuinely small repos: a fresh clone of a
    # README-only project measures 0.0 MB, and dsh-skills is 0.1 MB because it
    # is all markdown. The intent was "skip empty stubs", so test emptiness
    # directly instead of guessing from size.
    def _has_content(path):
        try:
            with os.scandir(path) as it:
                for e in it:
                    if e.name == ".git":
                        continue
                    if e.is_file():
                        return True
                    if e.is_dir() and any(os.scandir(e.path)):
                        return True
        except OSError:
            return False
        return False

    projects = [p for p in projects
                if not p.get("is_dsh_plugin")
                and "_dsh_unpacked" not in p["path"].lower()
                and _has_content(p["path"])]
    if moved:
        print("从项目区移到插件区（manifest 声明了 dsh.bundle/client）：")
        for m in moved:
            print(f"  {m}")
        print()

    # De-duplicate plugins by real path. Two DIFFERENT installs must both stay:
    # a local checkout of `dsh-purge` (Desktop\...\dsh-purge-plus, manifest name
    # "dsh-purge") and the linked copy under the profile's node_modules share the
    # same (name, version), so keying on that pair silently dropped the checkout —
    # it then appeared in neither the project list (moved out) nor the plugin list
    # (de-duplicated away). The path is what actually distinguishes an install.
    # The same package appearing in both the desktop and the web profile
    # node_modules still collapses, because both would be the same path only when
    # they really are the same directory.
    seen = set()
    uniq = []
    for p in sorted(plugins, key=lambda x: (x["name"], x["profile"], x["path"].lower())):
        key = os.path.normcase(os.path.abspath(p["path"]))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(p)
    plugins = uniq

    data = {"projects": projects, "plugins": plugins + tools_found}
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)

    print("=" * 100)
    print("项目区")
    print("=" * 100)
    for p in sorted(projects, key=lambda x: x["path"].lower()):
        tag = "git" if p["has_git"] else "dir"
        rem = p["remote"] or "-"
        print(f"{tag:4} {p['path']}")
        print(f"     {rem:40} {p['size_mb']:>8} MB  {p['description'][:48]}")

    print()
    print("=" * 100)
    print("插件区")
    print("=" * 100)
    for p in sorted(plugins, key=lambda x: x["name"]):
        print(f"{p['name']:28} {p['version']:12} {p['repo'] or '-':36} {p['description'][:40]}")

    print(f"\n写入 {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
