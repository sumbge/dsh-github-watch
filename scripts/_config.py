"""Shared configuration for the github-watch scripts.

The three scripts (inventory_local / build_inventory / check) all need the same
two facts: where the data directory is, and which roots to scan. Hardcoding
either makes the tool one-machine-only, so both are resolved here.

Resolution order for the data directory, first hit wins:
  1. DSH_GITHUB_WATCH_DIR
  2. <plugin>/config.json  {"watchDir": "..."}
  3. ~/.dsh-github-watch

Scan roots come from the same config ({"roots": ["D:\\code"]}) or from
DSH_GITHUB_WATCH_ROOTS (semicolon-separated). With neither, the usual
Desktop / Documents / Downloads are used.
"""
from __future__ import annotations

import json
import os


def _home() -> str:
    return os.path.expanduser("~")


def _plugin_dir() -> str:
    # scripts/ lives inside the plugin package; config.json sits one level up
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_config() -> dict:
    for path in (os.path.join(_plugin_dir(), "config.json"),):
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return data
        except (OSError, ValueError):
            pass
    return {}


def watch_dir() -> str:
    """Where inventory.json / report.md live."""
    from_env = os.environ.get("DSH_GITHUB_WATCH_DIR")
    if from_env:
        return from_env
    cfg = _read_config().get("watchDir")
    if isinstance(cfg, str) and cfg:
        return cfg
    return os.path.join(_home(), ".dsh-github-watch")


def roots() -> list[tuple[str, int]]:
    """(path, max_depth) pairs to walk.

    Defaults cover the directories people actually clone into. Depth is bounded
    because walking the whole tree is what made the first version take minutes.
    """
    cfg = _read_config()
    declared = cfg.get("roots") or []
    if isinstance(declared, str):
        declared = [declared]
    pairs = []
    for item in declared:
        if isinstance(item, str) and item:
            pairs.append((item, 5))
        elif isinstance(item, dict) and item.get("path"):
            pairs.append((item["path"], int(item.get("depth", 5))))
    if pairs:
        return pairs

    from_env = os.environ.get("DSH_GITHUB_WATCH_ROOTS")
    if from_env:
        return [(p.strip(), 5) for p in from_env.split(";") if p.strip()]

    home = _home()
    return [
        (os.path.join(home, "Desktop"), 5),
        (os.path.join(home, "Documents"), 4),
        (os.path.join(home, "Downloads"), 3),
    ]


def profile_node_modules() -> list[str]:
    """node_modules of every DSH profile on this machine."""
    base = os.path.join(_home(), ".dsh", "profiles")
    found = []
    try:
        for name in sorted(os.listdir(base)):
            nm = os.path.join(base, name, "node_modules")
            if os.path.isdir(nm):
                found.append(nm)
    except OSError:
        pass
    return found