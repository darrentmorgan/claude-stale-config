#!/usr/bin/env python3
"""Warn when a running Claude Code session runs on stale config.

Settings, MCP servers and instruction files load when a session starts. SessionStart
records a hash of each watched file for the session; UserPromptSubmit compares
them with the disk and warns once per change. /clear and compaction reload
instruction files, so those sources re-baseline instructions only. A /clear that
starts a new session id reuses the settings baseline saved at the first
SessionStart of the same claude process. SessionStart
also notes a `claude daemon` that started before the newest change, because its
spare sessions were pre-loaded on the old config; the next prompt shows it.

Always exits 0 and prints JSON. Any error fails open with {}.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time


MAX_INPUT_BYTES = 1_000_000
PRUNE_AFTER_SECONDS = 30 * 24 * 3600
# An @import can sit anywhere in a line, but not in code or an email address.
IMPORT = re.compile(r"(?<![\w`])@((?:~/|/|\.\.?/)?[\w.\-/]*[./][\w.\-/]*)")
CODE = re.compile(r"```.*?```|`[^`\n]*`", re.DOTALL)
IMPORT_DEPTH = 5
MAX_RULES = 200
# ~/.claude.json is rewritten all the time and can grow large: past this size its
# MCP servers are not tracked.
MAX_CLAUDE_JSON = 8_000_000
SESSION_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
INSTRUCTION_NAMES = ("CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md")
# Settings keys frozen at session start. Claude Code reloads the rest while a
# session runs: hooks, permissions and env were checked live on 2.1.302. On 2.1.311
# a headless session (-p, the SDK) keeps its start-up hooks, but its user cannot run
# /reload-plugins either, so a hooks edit stays unflagged.
FROZEN_SETTINGS = ("enabledPlugins",)
# Kinds of watched file whose change needs the claude process to reload. MCP servers
# start with the session: a server added to .mcp.json or ~/.claude.json mid-session
# stays absent, even from /mcp (checked live on 2.1.311).
FROZEN_KINDS = ("settings", "mcp")
EMPTY = hashlib.sha256(b"{}").hexdigest()


def watched_files(project: Path, home: Path) -> dict:
    """Map each watched path to "settings", "mcp" or "instructions"."""
    watched = {}
    for path in (home / ".claude/settings.json", project / ".claude/settings.json",
                 project / ".claude/settings.local.json"):
        watched[str(path)] = "settings"
    watched[str(project / ".mcp.json")] = "mcp"
    watched[str(home / ".claude.json")] = "mcp"
    instructions = [home / ".claude/CLAUDE.md", home / ".agents/AGENTS.md", project / "AGENTS.md"]
    directory = project
    while True:
        instructions += [directory / name for name in INSTRUCTION_NAMES]
        if directory == home or directory.parent == directory:
            break
        directory = directory.parent
    instructions += rules(home / ".claude/rules") + rules(project / ".claude/rules")
    level = instructions
    for _ in range(IMPORT_DEPTH):
        level = [target for path in level for target in imports(path, home)
                 if target not in instructions]
        instructions += level
    for path in instructions:
        watched.setdefault(str(path), "instructions")
    return watched


def rules(directory: Path) -> list:
    """The .md files under a rules directory, which load at start like CLAUDE.md."""
    try:
        return sorted(directory.rglob("*.md"))[:MAX_RULES]
    except OSError:
        return []


def imports(path: Path, home: Path) -> list:
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return []
    found = []
    for target in IMPORT.findall(CODE.sub("", text)):
        target = target.rstrip(".")
        if target.startswith("~/"):
            found.append(home / target[2:])
        elif target.startswith("/"):
            found.append(Path(target))
        else:
            found.append(path.parent / target)
    return found


def stat_key(path: str):
    try:
        info = os.stat(path)
    except OSError:
        return None
    return [info.st_mtime_ns, info.st_size]


def digest(path: str, kind: str = "instructions", project: str = None):
    if kind == "mcp" and path.endswith(os.sep + ".claude.json"):
        size = (stat_key(path) or [0, 0])[1]
        if size > MAX_CLAUDE_JSON:
            return None
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError:
        # A missing settings or MCP file sets nothing, the same as an empty one.
        return EMPTY if kind in FROZEN_KINDS else None
    if kind in FROZEN_KINDS:
        try:
            parsed = json.loads(data)
            if isinstance(parsed, dict):
                data = json.dumps(frozen_part(parsed, kind, path, project), sort_keys=True).encode()
        except ValueError:
            pass
    return hashlib.sha256(data).hexdigest()


def frozen_part(parsed: dict, kind: str, path: str, project: str = None) -> dict:
    if kind == "settings":
        return {key: parsed[key] for key in FROZEN_SETTINGS if key in parsed}
    frozen = {key: parsed[key] for key in ("mcpServers",) if parsed.get(key)}
    if path.endswith(os.sep + ".claude.json"):
        local = ((parsed.get("projects") or {}).get(project) or {}).get("mcpServers")
        if local:
            frozen["projectMcpServers"] = local
    return frozen


def record(path: str, kind: str, project: str = None) -> dict:
    entry = {"kind": kind, "hash": digest(path, kind, project), "stat": stat_key(path)}
    if kind == "settings":
        entry["keys"] = list(FROZEN_SETTINGS)
    if kind == "mcp":
        entry["project"] = project
    return entry


def state_dir(env: dict) -> Path:
    base = env.get("CLAUDE_PLUGIN_DATA")
    if not base:
        import tempfile
        base = os.path.join(tempfile.gettempdir(), "stale-config-plugin")
    return Path(base) / "stale-config"


def load(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data))
    os.replace(temp, path)


def show(path: str, home: Path) -> str:
    prefix = str(home) + os.sep
    return "~/" + path[len(prefix):] if path.startswith(prefix) else path


def baseline(state: dict, watched: dict, source: str, project: Path) -> dict:
    files = state.get("files") or {}
    reload_all = source not in ("clear", "compact") or not files
    fresh = {}
    for path, kind in watched.items():
        if kind in FROZEN_KINDS and not reload_all and path in files:
            fresh[path] = files[path]
        else:
            fresh[path] = record(path, kind, str(project))
    return {"files": fresh, "warned": {}}


def process_path(directory: Path, process) -> Path:
    pid, started = process
    return directory / f"process-{pid}-{int(started)}.json"


def use_process_baseline(state: dict, directory: Path, process) -> None:
    """Settings load once per claude process, so its first SessionStart's record is the
    true baseline for every session id the process runs. Save it once, then reuse it,
    with the changes the process has already warned about."""
    if not process:
        return
    state["process"] = list(process)
    path = process_path(directory, process)
    data = load(path)
    saved = data.get("files") or {}
    files = state["files"]
    for name, entry in files.items():
        if entry["kind"] in FROZEN_KINDS and isinstance(saved.get(name), dict):
            files[name] = dict(saved[name])
    state["warned"].update(data.get("warned") or {})
    if path.exists():
        os.utime(path)  # keeps a long-lived process's baseline from being pruned
    else:
        # An entry marked unknown is not a baseline: the next session id records the disk.
        save(path, {"files": {name: entry for name, entry in files.items()
                              if entry["kind"] in FROZEN_KINDS
                              and not str(entry["hash"]).startswith("unknown")}})


def share_warned(state: dict, changed: list, directory: Path) -> None:
    """Record settings warnings for the process, so a /clear does not repeat them."""
    process = state.get("process")
    settings = [path for path, kind in changed if kind in FROZEN_KINDS]
    if not process or not settings:
        return
    path = process_path(directory, process)
    data = load(path)
    if not data:
        return
    warned = data.setdefault("warned", {})
    for name in settings:
        warned[name] = state["warned"][name]
    save(path, data)


def mark_changed_after(files: dict, started: float, kinds=FROZEN_KINDS + ("instructions",)) -> None:
    for path, entry in files.items():
        if path.endswith(os.sep + ".claude.json"):
            continue  # Claude Code rewrites it all the time, so its mtime says nothing
        if entry["kind"] in kinds and entry["stat"] and entry["stat"][0] >= started * 1e9:
            entry["hash"] = "unknown: changed after session start"
            entry["stat"] = None


def changed_files(state: dict) -> list:
    changed = []
    warned = state.setdefault("warned", {})
    for path, entry in state.get("files", {}).items():
        current_stat = stat_key(path)
        if current_stat == entry.get("stat"):
            continue
        entry["stat"] = current_stat
        state["dirty"] = True
        current = digest(path, entry.get("kind"), entry.get("project"))
        if entry.get("kind") in FROZEN_KINDS and entry.get("hash") is None:
            entry["hash"] = EMPTY  # recorded missing by an older version
        if entry.get("kind") == "settings" and entry.get("keys") != list(FROZEN_SETTINGS):
            # Hashed over another key set by an older version: take the disk as the baseline.
            entry.update(hash=current, keys=list(FROZEN_SETTINGS))
            continue
        if current == entry.get("hash"):
            warned.pop(path, None)
            continue
        if warned.get(path) == current:
            continue
        warned[path] = current
        changed.append((path, entry.get("kind")))
    return changed


def warning(changed: list, home: Path, pending=None) -> dict:
    settings = [show(p, home) for p, kind in changed if kind == "settings"]
    mcp = [show(p, home) for p, kind in changed if kind == "mcp"]
    instructions = [show(p, home) for p, kind in changed if kind not in FROZEN_KINDS]
    parts = [pending] if pending else []
    if settings:
        parts.append(f"{', '.join(settings)} changed since this session started. "
                     "enabledPlugins loads only at start: run /reload-plugins to use it.")
    if mcp:
        parts.append(f"MCP servers in {', '.join(mcp)} changed. They load only at start: "
                     "restart the session (claude --continue) to use them.")
    if instructions:
        # The context below has Claude re-read them on this prompt, so the user needs to do nothing.
        parts.append(f"{', '.join(instructions)} changed. "
                     f"This session re-reads {'them' if len(instructions) > 1 else 'it'} on this message.")
    if changed:
        context = ("Stale config: these files changed on disk after this session loaded them: "
                   + ", ".join(p for p, _ in changed)
                   + ". Re-read any changed instruction files now and follow the current version. "
                   "A changed enabledPlugins setting needs /reload-plugins, and changed MCP "
                   "servers need a session restart; tell the user if that blocks the work.")
    else:
        context = "Stale config: " + pending
    return {"systemMessage": "Stale config. " + " ".join(parts),
            "hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": context}}


def run_ps() -> str:
    import subprocess
    try:
        return subprocess.run(["ps", "-axo", "pid=,ppid=,lstart=,command="], capture_output=True,
                              text=True, timeout=2).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def processes(output: str) -> dict:
    """Map pid to (ppid, start time, first three argv basenames) from ps output."""
    found = {}
    for line in output.splitlines():
        parts = line.split(None, 7)
        if len(parts) < 8 or not parts[0].isdigit() or not parts[1].isdigit():
            continue
        try:
            started = time.mktime(time.strptime(" ".join(parts[2:7]), "%a %b %d %H:%M:%S %Y"))
        except ValueError:
            continue
        names = [os.path.basename(token) for token in parts[7].split()[:3]]
        found[int(parts[0])] = (int(parts[1]), started, names)
    return found


def is_claude(names: list, sub: str = None) -> bool:
    for i in range(2):
        if names[i:i + 1] == ["claude"]:
            return sub is None or names[i + 1:i + 2] == [sub]
    return False


def daemons(output: str) -> list:
    return [(pid, started) for pid, (_, started, names) in processes(output).items()
            if is_claude(names, "daemon")]


def claude_process(table: dict, pid: int):
    """(pid, start time) of the nearest claude ancestor of pid, if any."""
    for _ in range(20):
        if pid not in table:
            return None
        parent, started, names = table[pid]
        if is_claude(names) and not is_claude(names, "daemon"):
            return pid, started
        pid = parent
    return None


def stale_daemons(watched: dict, home: Path, directory: Path, output: str) -> list:
    # Only user-level files: a daemon serves every project, and project edits are routine.
    user_level = [p for p in watched if p.startswith(str(home / ".claude") + os.sep)
                  or p.startswith(str(home / ".agents") + os.sep)]
    newest = max((s[0] for s in map(stat_key, user_level) if s), default=0)
    if not newest:
        return []
    seen_path = directory / "daemons.json"
    cutoff = time.time() - PRUNE_AFTER_SECONDS
    seen = {key: when for key, when in load(seen_path).items()
            if isinstance(when, (int, float)) and when >= cutoff}
    stale = []
    for pid, started in daemons(output):
        key = f"{pid}:{newest}"
        if started * 1e9 < newest and key not in seen:
            seen[key] = time.time()
            stale.append(pid)
    if stale:
        save(seen_path, seen)
    return stale


def prune(directory: Path) -> None:
    cutoff = time.time() - PRUNE_AFTER_SECONDS
    try:
        for path in directory.glob("*.json"):
            if path.stat().st_mtime < cutoff:
                path.unlink()
    except OSError:
        pass


def handle(event: dict, env: dict, ps=run_ps, ppid=None) -> dict:
    name = event.get("hook_event_name")
    session = event.get("session_id")
    if name not in ("SessionStart", "UserPromptSubmit") or not isinstance(session, str) \
            or not SESSION_ID.match(session):
        return {}
    home = Path(env.get("HOME") or Path.home())
    directory = state_dir(env)
    state_path = directory / f"{session}.json"
    state = load(state_path)

    if name == "SessionStart":
        project = Path(env.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd())
        watched = watched_files(project, home)
        source = str(event.get("source") or "")
        output = ps()
        process = claude_process(processes(output), ppid or os.getppid())
        if source in ("clear", "compact") and not state.get("files"):
            # /clear starts a new session id in the same process: settings were loaded when
            # the process started. Without a process baseline, treat any settings change
            # since then as unseen.
            state = baseline({}, watched, "startup", project)
            if process and not process_path(directory, process).exists():
                mark_changed_after(state["files"], process[1], kinds=FROZEN_KINDS)
        else:
            state = baseline(state, watched, source, project)
        use_process_baseline(state, directory, process)
        prune(directory)
        stale = stale_daemons(watched, home, directory, output)
        notes = []
        if stale:
            notes.append(f"claude daemon (pid {', '.join(map(str, stale))}) started before your latest "
                         "settings or instruction change, so its spare sessions run old config. "
                         "Run `claude daemon stop --any` to refresh it.")
        if notes:
            # SessionStart's systemMessage is not shown in every client, so the first prompt carries it.
            state["pending"] = " ".join(notes)
        save(state_path, state)
        return {}

    if not state.get("files"):
        project = Path(env.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd())
        # No SessionStart record: the hook arrived mid-session (plugin install or reload).
        # The session loaded its config when its claude process started, not when its
        # transcript began (a resumed session reloads), so only later changes count.
        state = baseline({}, watched_files(project, home), "startup", project)
        process = claude_process(processes(ps()), ppid or os.getppid())
        if process:
            mark_changed_after(state["files"], process[1])
        use_process_baseline(state, directory, process)
        save(state_path, state)
    changed = changed_files(state)
    share_warned(state, changed, directory)
    pending = state.pop("pending", None)
    if state.pop("dirty", False) or pending:
        save(state_path, state)
    if not changed and not pending:
        return {}
    return warning(changed, home, pending)


def main() -> None:
    output = {}
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) <= MAX_INPUT_BYTES:
            event = json.loads(raw)
            if isinstance(event, dict):
                output = handle(event, dict(os.environ))
    except Exception:
        output = {}
    sys.stdout.write(json.dumps(output))


if __name__ == "__main__":
    main()
