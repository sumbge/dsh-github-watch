#!/usr/bin/env python3
"""GitHub 项目更新检查器 —— 一个项目一行，skill/插件都归到它所属的项目里。

设计要点（都来自实测）：
  * 按 repo 归并，不按本地目录。同一个项目你可能有 3 份克隆（autoforge 就是），
    报告里只出现一行，另附克隆列表。
  * 更新的判定用「上游最新 commit sha != 本地 HEAD」，不是比 tag、不是比日期。
  * 每个项目一条探测策略，按能力降级：
        git   -> git ls-remote（私有仓库要带 token）
        api   -> GitHub REST commits?per_page=1
        npm   -> npm view <name> version
        none  -> 无上游可查（自建/已 gitignore），单独列出而不是假装「最新」
  * 有 token 就用，没 token 走匿名（60/小时），额度耗尽时明确报出来而不是静默失败。

用法：
    python check.py            # 检查并写 report.md
    python check.py --no-write # 只打印，不落盘
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

# 中文 Windows 控制台默认 GBK：emoji 和部分符号会直接抛 UnicodeEncodeError。
# 不靠调用方设 PYTHONIOENCODING，脚本自己保证 stdout 能写。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")   # py3.7+
    except Exception:                                             # noqa: BLE001
        pass

# Data lives in the configured watch directory, not next to this script:
# check.py ships inside scripts/, while inventory.json and report.md belong
# to the operator data directory.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _config import watch_dir

BASE = watch_dir()
STATE = os.path.join(BASE, "state.json")
REPORT = os.path.join(BASE, "report.md")

# How long a finished check stays authoritative. The upstream facts this plugin
# tracks (a release, a commit) do not change minute to minute, and the anonymous
# GitHub API allows 60 requests/hour, so re-checking within a few minutes burns
# the budget to learn nothing. `--force` overrides it.
CACHE_TTL_SECONDS = 6 * 3600

# Concurrent upstream probes. Kept small: the anonymous GitHub API allows 60
# requests/hour, and eight parallel git ls-remote calls already saturate a home
# connection. Raising this trades GitHub rate-limit risk for little wall clock.
PROBE_WORKERS = 8

UA = "dsh-github-watch/1.0"


# ── token ────────────────────────────────────────────────────────────────
def github_token() -> str:
    """环境变量优先，其次 git credential store（实测本机存的是 gho_ OAuth token）。"""
    for key in ("GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT"):
        if os.environ.get(key):
            return os.environ[key].strip()
    path = os.path.join(os.path.expanduser("~"), ".git-credentials")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r"^https://([^:]+):([^@]+)@github\.com", line.strip())
                if m:
                    return m.group(2)
    except OSError:
        pass
    return ""


TOKEN = github_token()


def api(path: str, timeout: int = 25):
    """GET api.github.com。返回 (data, error)。额度耗尽会明确说明。"""
    url = "https://api.github.com" + path
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": UA,
        **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace")), None
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None, "404 仓库不存在或无权限"
        if exc.code in (403, 429):
            reset = exc.headers.get("x-ratelimit-reset")
            when = ""
            if reset:
                when = datetime.fromtimestamp(int(reset)).strftime("%H:%M")
            return None, f"限流/拒绝({exc.code})，额度重置 {when}"
        return None, f"HTTP {exc.code}"
    except Exception as exc:                       # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"


def git(*args: str, cwd: str | None = None, timeout: int = 40):
    """跑 git，返回 (stdout, returncode, stderr)。"""
    try:
        p = subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True,
            timeout=timeout, encoding="utf-8", errors="replace",
        )
        return p.stdout.strip(), p.returncode, p.stderr.strip()
    except subprocess.TimeoutExpired:
        return "", 124, "超时"
    except Exception as exc:                       # noqa: BLE001
        return "", 1, f"{type(exc).__name__}: {exc}"


def remote_url(slug: str) -> str:
    return f"https://x-access-token:{TOKEN}@github.com/{slug}.git" if TOKEN else f"https://github.com/{slug}.git"


# ── 三种探测 ─────────────────────────────────────────────────────────────
def probe_git(slug: str, branch: str, local_paths: list[str]) -> dict:
    """ls-remote 拿上游 sha，和每个本地克隆的 HEAD 比。"""
    # `branch` may be empty when the caller does not know it. Asking for
    # "refs/heads/None" is what a naive f-string produces, and git answers with
    # an empty error — five projects reported "ls-remote 失败: " and nothing
    # else. Resolve the default branch from the remote instead of guessing.
    if not branch:
        head_out, head_rc, _ = git("ls-remote", "--symref", remote_url(slug), "HEAD")
        if head_rc == 0 and head_out:
            m = re.search(r"refs/heads/(\S+)", head_out)
            if m:
                branch = m.group(1)
    if not branch:
        return {"ok": False, "error": "无法确定默认分支"}

    out, rc, err = git("ls-remote", "--heads", remote_url(slug), f"refs/heads/{branch}")
    if rc != 0 or not out:
        msg = err.replace(TOKEN, "***") if TOKEN else err
        return {"ok": False, "error": f"ls-remote 失败: {msg[:200]}"}
    remote_sha = out.split()[0][:7]

    clones = []
    for path in local_paths:
        if not os.path.isdir(path):
            clones.append({"path": path, "missing": True})
            continue
        head, rc2, _ = git("rev-parse", "--short=7", "HEAD", cwd=path)
        dirty, _, _ = git("status", "--porcelain", cwd=path)
        behind, rc3, _ = git("rev-list", "--count", f"{head}..origin/{branch}", cwd=path, timeout=25)
        clones.append({
            "path": path,
            "head": head if rc2 == 0 else None,
            "dirty": len([l for l in dirty.splitlines() if l.strip()]),
            "behind": int(behind) if rc3 == 0 and behind.isdigit() else None,
        })
    return {"ok": True, "remote_sha": remote_sha, "clones": clones}


def probe_api(slug: str, branch: str | None = None) -> dict:
    """查上游最新 commit。branch 为 None 时用仓库默认分支。

    不写死 "main"：OmniParser 的默认分支是 master，用 ?sha=main 会得到 404，
    那个 404 看起来像「仓库不存在」，实际上只是分支名猜错了。
    """
    if not branch:
        info, err = api(f"/repos/{slug}")
        if err:
            return {"ok": False, "error": err}
        branch = info.get("default_branch") or "main"
    data, err = api(f"/repos/{slug}/commits?sha={branch}&per_page=1")
    if err:
        # 分支名不对时退回默认分支再试一次，而不是把它报成失败
        if "404" in err:
            info, err2 = api(f"/repos/{slug}")
            if not err2:
                fallback = info.get("default_branch") or "main"
                if fallback != branch:
                    data, err = api(f"/repos/{slug}/commits?sha={fallback}&per_page=1")
                    branch = fallback
        if err:
            return {"ok": False, "error": err}
    if not data:
        return {"ok": False, "error": "无 commit 数据"}
    c = data[0]
    return {
        "ok": True,
        "remote_sha": c["sha"][:7],
        "branch": branch,
        "date": c["commit"]["committer"]["date"],
        "message": (c["commit"]["message"].splitlines() or [""])[0][:70],
    }


def probe_npm(name: str) -> dict:
    """查 npm 上的最新版本。

    坑（实测）：`npm view <pkg> version` 对已下架的包返回 rc=1，但 stdout 和
    stderr 都是空的 —— E404 被 npm 自己吞掉了。所以判定不能靠「有没有输出」，
    必须靠 returncode：
        rc=0 且有版本  -> 正常，比版本号
        rc!=0          -> 上游取不到（下架/闭库/私有），这是「已下架」而非「检查失败」
    只有真正抛异常（超时、npm 不存在）才算检查失败。
    """
    npm = "npm.cmd" if os.name == "nt" else "npm"
    try:
        p = subprocess.run(
            [npm, "view", name, "version", "--silent"],
            capture_output=True, text=True, timeout=60,
            encoding="utf-8", errors="replace",
        )
        ver = (p.stdout or "").strip()
        if p.returncode == 0 and ver:
            return {"ok": True, "latest": ver}
        if p.returncode != 0:
            blob = (p.stdout or "") + (p.stderr or "")
            gone = ("E404" in blob or "Not Found" in blob or "404" in blob
                    or not blob.strip())
            return {"ok": True, "latest": None, "gone": gone,
                    "error": "npm 上已不存在（rc=%d）" % p.returncode}
        return {"ok": False, "error": "rc=0 但没有版本输出"}
    except FileNotFoundError:
        return {"ok": False, "error": "找不到 npm"}
    except Exception as exc:                       # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


# ── 主流程 ───────────────────────────────────────────────────────────────
@dataclass
class Row:
    name: str
    kind: str
    status: str = ""            # 有更新 / 最新 / 检查失败 / 无上游
    detail: str = ""
    slug: str = ""
    clones: list = field(default_factory=list)
    versions: str = ""


def load_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return default


def version_key(v: str):
    return [int(x) if x.isdigit() else 0 for x in re.split(r"[.\-+]", str(v))[:4]]


def check_all(projects: dict, state: dict) -> list[Row]:
    rows: list[Row] = []
    last = state.setdefault("seen", {})

    # Live progress for the Settings page. This step is ~85% of a scan's wall
    # clock (14 network round-trips against one 2-second disk walk), and a page
    # can only report what it can read — so each finished project is written out
    # as it completes, not at the end. Best-effort: a failed write must never
    # break the check itself.
    prog_path = os.path.join(BASE, "scan_progress.json")
    total = len(projects.get("projects", []))

    def emit(done: int, name: str) -> None:
        # Overwritten from scratch on every run (the first call is emit(0, "")).
        # Left on disk afterwards on purpose: when a check dies partway, this is
        # the only record of how far it got. `at` distinguishes a finished copy
        # from one that stopped mid-run.
        try:
            tmp = prog_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"done": done, "total": total, "current": name,
                           "at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")},
                          fh, ensure_ascii=False)
            os.replace(tmp, prog_path)
        except OSError:
            pass

    emit(0, "")

    # Probe every project concurrently, then consume the results in order. The
    # probes are almost entirely network round-trips, so running them serially
    # made the check as slow as the sum of its latencies. The reporting loop
    # below stays sequential: it decides status wording and emits progress, and
    # keeping it unchanged means the concurrent path cannot alter any message.
    prefetched: dict[tuple, object] = {}

    def _probe_key(proj: dict, pr: dict) -> tuple:
        how = pr.get("type")
        if how == "npm":
            return ("npm", proj.get("npm_name") or proj["name"])
        return (how, proj.get("slug"), pr.get("branch"))

    def _prefetch(proj: dict) -> list[tuple]:
        out = []
        for pr in proj.get("probe") or []:
            key = _probe_key(proj, pr)
            how = pr.get("type")
            try:
                if how == "git":
                    val = probe_git(proj["slug"], pr.get("branch", "main"), proj.get("paths", []))
                elif how == "api":
                    val = probe_api(proj["slug"], pr.get("branch"))
                elif how == "npm":
                    val = probe_npm(proj.get("npm_name") or proj["name"])
                else:
                    continue
            except Exception as exc:                      # noqa: BLE001
                val = {"ok": False, "error": str(exc)}
            out.append((key, val))
            # One attempt per project is enough: the loop below stops at the
            # first successful probe, so later probes for the same project would
            # only be fetched to be discarded.
            if val and val.get("ok"):
                break
        return out

    probe_targets = [p for p in projects.get("projects", []) if p.get("probe")]
    if probe_targets:
        with ThreadPoolExecutor(max_workers=PROBE_WORKERS) as pool:
            for pairs in pool.map(_prefetch, probe_targets):
                for key, val in pairs:
                    prefetched[key] = val

    for idx, proj in enumerate(projects.get("projects", []), start=1):
        r = Row(name=proj["name"], kind=proj.get("kind", "?"), slug=proj.get("slug", ""),
                versions=proj.get("local_version") or "")
        probes = proj.get("probe") or []
        if not probes:
            r.status = "无上游"
            r.detail = proj.get("note", "自建/无上游，不追踪")
            rows.append(r)
            emit(idx, proj["name"])
            continue

        got = None
        errors = []
        for pr in probes:
            how = pr.get("type")
            cached = prefetched.get(_probe_key(proj, pr))
            if how == "git":
                got = cached if cached is not None else probe_git(proj["slug"], pr.get("branch", "main"), proj.get("paths", []))
            elif how == "api":
                got = cached if cached is not None else probe_api(proj["slug"], pr.get("branch"))
                if got.get("ok"):
                    # api 只能给上游，本地 HEAD 仍需 git 读
                    for path in proj.get("paths", []):
                        if os.path.isdir(path):
                            head, rc, _ = git("rev-parse", "--short=7", "HEAD", cwd=path)
                            dirty, _, _ = git("status", "--porcelain", cwd=path)
                            r.clones.append({
                                "path": path, "head": head if rc == 0 else None,
                                "dirty": len([l for l in dirty.splitlines() if l.strip()]),
                                "behind": None,
                            })
            elif how == "npm":
                got = cached if cached is not None else probe_npm(proj.get("npm_name") or proj["name"])
                if got.get("ok"):
                    lv = proj.get("local_version") or ""
                    if got.get("gone"):
                        r.status = "上游已下架"
                        r.detail = f"本地仍有 {lv or '?'}，npm 上已取不到"
                        if proj.get("note"):
                            r.detail += " ｜ " + proj["note"]
                    elif lv and version_key(got["latest"]) > version_key(lv):
                        r.status = "有更新"
                        r.detail = f"本地 {lv} → 上游 {got['latest']}"
                        if proj.get("note"):
                            r.detail += " ｜ " + proj["note"]
                    else:
                        r.status = "最新"
                        r.detail = f"本地 {lv or '?'} = 上游 {got['latest']}"
                        if proj.get("note"):
                            r.detail += " ｜ " + proj["note"]
                    r.versions = f"{lv or '?'} → {got.get('latest') or '（无）'}"
                else:
                    errors.append(got.get("error", ""))
                break
            if got and got.get("ok"):
                break
            if got:
                errors.append(got.get("error", ""))

        if got is None or not got.get("ok"):
            r.status = "检查失败"
            r.detail = "; ".join(e for e in errors if e)[:180]
            rows.append(r)
            emit(idx, proj['name'])
            continue

        if r.kind == "npm":
            rows.append(r)
            emit(idx, proj['name'])
            continue

        r.clones = got.get("clones", r.clones)
        remote_sha = got.get("remote_sha")

        # 快照类（无 .git）：没有本地 HEAD 可比，只能拿「上游最新提交时间」
        # 和「本地目录最后修改时间」比。这仍然不能证明落后多少，所以措辞用
        # 「上游有新提交」，绝不说「最新」—— 你改过 OmniParser，说最新就是撒谎。
        if r.kind == "snapshot":
            up_date = (got.get("date") or "")[:10]
            local_mtime = None
            for path in proj.get("paths", []):
                if os.path.isdir(path):
                    try:
                        local_mtime = max(
                            (os.path.getmtime(os.path.join(path, f)) for f in os.listdir(path)),
                            default=os.path.getmtime(path),
                        )
                        break
                    except OSError:
                        pass
            local_day = datetime.fromtimestamp(local_mtime).strftime("%Y-%m-%d") if local_mtime else "?"
            newer = bool(up_date and local_mtime and up_date > local_day)
            r.status = "上游有新版" if newer else "未见新版"
            bits = [f"上游 {up_date}", f"本地 {local_day}"]
            if proj.get("local_version"):
                bits.insert(0, f"本地版本 {proj['local_version']}")
            if proj.get("note"):
                bits.append(proj["note"])
            r.detail = " ｜ ".join(bits)
            rows.append(r)
            emit(idx, proj['name'])
            continue

        shas = {c.get("head") for c in r.clones if c.get("head")}
        if not shas:
            r.status = "检查失败"
            r.detail = "本地没有可读的 git HEAD"
        elif remote_sha in shas:
            r.status = "最新"
        else:
            behind = [c.get("behind") for c in r.clones if c.get("behind")]
            r.status = "有更新"
            r.detail = (f"落后 {max(behind)} 个提交" if behind else
                        f"上游 {remote_sha} ≠ 本地 {'/'.join(sorted(shas))}")
        if got.get("message"):
            r.detail = (r.detail + " ｜ " if r.detail else "") + f"最新提交: {got['message']}"
        if got.get("date"):
            r.detail = (r.detail + " ｜ " if r.detail else "") + got["date"][:10]
        last[proj["name"]] = remote_sha
        rows.append(r)
        emit(idx, proj["name"])

    return rows


def render(rows: list[Row], projects: dict) -> str:
    order = {"有更新": 0, "上游已下架": 1, "上游有新版": 2, "检查失败": 3,
             "无上游": 4, "未见新版": 5, "最新": 6}
    rows = sorted(rows, key=lambda r: (order.get(r.status, 9), r.name.lower()))
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    n_up = sum(1 for r in rows if r.status == "有更新")
    n_new = sum(1 for r in rows if r.status == "上游有新版")
    n_gone = sum(1 for r in rows if r.status == "上游已下架")
    n_ok = sum(1 for r in rows if r.status in ("最新", "未见新版"))
    n_err = sum(1 for r in rows if r.status == "检查失败")
    n_na = sum(1 for r in rows if r.status == "无上游")

    out = [f"# GitHub 项目更新报告", "",
           f"生成时间：{now}　｜　共 **{len(rows)}** 个项目",
           f"有更新 **{n_up}**　上游有新提交 {n_new}　已下架 {n_gone}　"
           f"已最新 {n_ok}　失败 {n_err}　无上游 {n_na}", ""]

    if n_up:
        out += ["## 可以 pull 的（有 .git，落后上游）", ""]
        for r in rows:
            if r.status != "有更新":
                continue
            out.append(f"### {r.name}")
            if r.slug:
                out.append(f"https://github.com/{r.slug}")
            if r.detail:
                out.append(f"> {r.detail}")
            for c in r.clones:
                flag = " ⚠ 有未提交改动" if c.get("dirty") else ""
                miss = " （目录不存在）" if c.get("missing") else ""
                out.append(f"- `{c['path']}`{miss}{flag}  HEAD {c.get('head') or '?'}")
            out.append("")

    if n_new:
        out += ["## 上游有新提交，但本地不是 git（无法直接 pull）", ""]
        for r in rows:
            if r.status != "上游有新版":
                continue
            out.append(f"- **{r.name}** — {r.detail}")
        out.append("")

    out += ["## 全部项目", "", "| 项目 | 类型 | 状态 | 说明 |", "|---|---|---|---|"]
    for r in rows:
        mark = {"有更新": "🔴", "最新": "✅", "上游有新版": "🟡", "上游已下架": "⛔",
                "未见新版": "✅", "检查失败": "⚠️", "无上游": "—"}.get(r.status, "")
        out.append(f"| {r.name} | {r.kind} | {mark} {r.status} | {r.detail[:70]} |")

    out += ["", "---", "",
            f"token: {'已用（额度 5000/h）' if TOKEN else '未用（匿名 60/h）'}　"
            f"｜　探测方式按项目降级：git → api → npm", ""]
    return "\n".join(out)


def registry_from_inventory() -> dict:
    """Translate inventory.json into the shape check_all() expects.
   
    Two files used to describe the same projects: projects.json (20 entries,
    what the checker read) and inventory.json (what the page showed). They
    drifted — the checker kept probing dsh-purge-plus after its directory was
    deleted, and returned exit 1 every run because of it, while the page had
    long stopped showing that row. One registry, read by both, is the only
    arrangement where "the page says X" and "the check says X" cannot disagree.
    """
    inv = load_json(os.path.join(BASE, "inventory.json"), None)
    if not inv:
        return {"projects": []}

    out = []
    for p in inv.get("projects", []):
        entry = {
            "name": p["name"],
            "kind": p.get("kind", "git"),
            "slug": p.get("slug", ""),
            "paths": [x for x in [p.get("path")] if x],
            "local_version": p.get("version") or None,
            "note": p.get("note", ""),
        }
        # A muted project is skipped by emptying its probe list, not by dropping
        # the row. Dropping it would make the page and the checker disagree about
        # what exists — the exact drift this function was written to end — and it
        # would also spend nothing here but hide the fact that it was deliberately
        # parked. `muted` survives in inventory.json so the page can say why.
        if p.get("muted"):
            entry["probe"] = []
            entry["muted"] = True
            entry["note"] = "已屏蔽，不检查更新"
        elif p.get("kind") == "git" and not entry["slug"]:
            entry["probe"] = []
        elif p.get("kind") == "git":
            entry["probe"] = [{"type": "git", "branch": None}]
        elif p.get("kind") == "snapshot":
            entry["probe"] = [{"type": "api", "branch": None}]
        else:
            entry["probe"] = []
        out.append(entry)

    # Plugins have no checkout to diff against; their upstream version comes
    # from npm, so they are probed that way and only when they name a package.
    for p in inv.get("plugins", []):
        if not p.get("slug"):
            continue
        if p.get("muted"):
            continue      # muted plugin: no npm lookup either
        out.append({
            "name": p["name"],
            "kind": "npm",
            "slug": p.get("slug", ""),
            "npm_name": p["name"],
            "local_version": p.get("version") or None,
            "probe": [{"type": "npm"}],
            "note": p.get("note", ""),
        })

    return {"projects": out}


def main() -> int:
    projects = registry_from_inventory()
    if not projects.get("projects"):
        print("缺少 inventory.json 或其中没有项目", file=sys.stderr)
        return 2
    state = load_json(STATE, {})

    # Re-running a check seconds after the last one answers nothing new and spends
    # the anonymous 60/hour GitHub budget on identical questions. Serve the cached
    # row set while it is fresh; `--force` exists for when the caller knows better.
    cache = state.get("cache") or {}
    cache_age = None
    if cache.get("at"):
        try:
            cache_age = time.time() - float(cache["at"])
        except (TypeError, ValueError):
            cache_age = None
    fresh = cache_age is not None and cache_age < CACHE_TTL_SECONDS
    if fresh and cache.get("rows") and "--force" not in sys.argv:
        age_min = int(cache_age // 60)
        print(f"（缓存 {age_min} 分钟内的结果，--force 可强制重查）", file=sys.stderr)
        rows = [Row(**r) for r in cache["rows"]]
        text = render(rows, projects)
        print(text)
        if "--no-write" not in sys.argv:
            with open(REPORT, "w", encoding="utf-8") as fh:
                fh.write(text)
        return 0

    t0 = time.time()
    rows = check_all(projects, state)
    elapsed = time.time() - t0

    state["cache"] = {
        "at": time.time(),
        "rows": [asdict(r) for r in rows],
    }

    text = render(rows, projects)
    print(text)
    print(f"\n耗时 {elapsed:.1f}s", file=sys.stderr)

    if "--no-write" not in sys.argv:
        with open(REPORT, "w", encoding="utf-8") as fh:
            fh.write(text)
        with open(STATE, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=1)
        # 日志自己写：bat 里用 >> 重定向时，Python 的 UTF-8 输出会被 cmd 当 GBK
        # 解读，日志变成乱码。自己 append 就绕开了整条 shell 编码链。
        try:
            with open(os.path.join(BASE, "run.log"), "a", encoding="utf-8") as fh:
                fh.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] "
                         f"{len(rows)} 个项目，有更新 {sum(1 for r in rows if r.status == '有更新')}，"
                         f"耗时 {elapsed:.1f}s\n")
        except OSError:
            pass
        print(f"已写入 {REPORT}", file=sys.stderr)

    return 0 if not any(r.status == "检查失败" for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
