"""Tests for the stale-config hook."""

import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "hooks/stale-config.py"
HOOKS_JSON = SCRIPT.parent / "hooks.json"
SPEC = importlib.util.spec_from_file_location("stale_config", SCRIPT)
stale = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stale)

NO_DAEMONS = lambda: ""  # noqa: E731


class StaleConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home = root / "home"
        self.project = root / "home/developer/repo"
        self.data = root / "data"
        for path in (self.home / ".claude", self.home / ".agents", self.project / ".claude", self.data):
            path.mkdir(parents=True, exist_ok=True)
        self.user_claude = self.home / ".claude/CLAUDE.md"
        self.agents = self.home / ".agents/AGENTS.md"
        self.user_settings = self.home / ".claude/settings.json"
        self.project_claude = self.project / "CLAUDE.md"
        self.project_settings = self.project / ".claude/settings.json"
        self.user_claude.write_text("@~/.agents/AGENTS.md\n")
        self.agents.write_text("# rules v1\n")
        self.user_settings.write_text("{}\n")
        self.project_claude.write_text("# project\n")
        self.project_settings.write_text("{}\n")
        self.env = {"HOME": str(self.home), "CLAUDE_PLUGIN_DATA": str(self.data),
                    "CLAUDE_PROJECT_DIR": str(self.project)}

    def tearDown(self):
        self.tmp.cleanup()

    def event(self, name, **extra):
        data = {"hook_event_name": name, "session_id": "s1", "cwd": str(self.project)}
        data.update(extra)
        return data

    def start(self, source="startup", ps=NO_DAEMONS):
        return stale.handle(self.event("SessionStart", source=source), self.env, ps=ps)

    def prompt(self):
        return stale.handle(self.event("UserPromptSubmit", prompt="hi"), self.env, ps=NO_DAEMONS)

    def test_silent_when_nothing_changed(self):
        self.assertEqual(self.start(), {})
        self.assertEqual(self.prompt(), {})
        self.assertEqual(self.prompt(), {})

    def test_watches_expected_files(self):
        watched = stale.watched_files(self.project, self.home)
        for path, kind in ((self.user_claude, "instructions"), (self.agents, "instructions"),
                           (self.project_claude, "instructions"), (self.user_settings, "settings"),
                           (self.project_settings, "settings")):
            with self.subTest(path=path.name):
                self.assertEqual(watched.get(str(path)), kind)

    def test_settings_change_warns_once_with_restart_fix(self):
        self.start()
        self.user_settings.write_text('{"enabledPlugins": {}}\n')
        first = self.prompt()
        self.assertIn("~/.claude/settings.json", first["systemMessage"])
        self.assertIn("enabledPlugins", first["systemMessage"])
        self.assertIn("/reload-plugins", first["systemMessage"])
        self.assertIn("/reload-plugins", first["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(first["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
        self.assertEqual(self.prompt(), {})
        self.user_settings.write_text('{"enabledPlugins": {"x@y": true}}\n')
        self.assertIn("settings.json", self.prompt()["systemMessage"])

    def test_instruction_change_needs_no_action_and_tells_claude_to_reread(self):
        self.start()
        self.agents.write_text("# rules v2\n")
        out = self.prompt()
        self.assertIn("~/.agents/AGENTS.md changed. This session re-reads it on this message.",
                      out["systemMessage"])
        self.assertNotIn("/clear", out["systemMessage"])
        self.assertNotIn("restart", out["systemMessage"].lower())
        self.assertIn("Re-read any changed instruction files now", out["hookSpecificOutput"]["additionalContext"])
        self.assertIn(str(self.agents), out["hookSpecificOutput"]["additionalContext"])

    def test_clear_rebaselines_instructions_but_not_settings(self):
        self.start()
        self.project_claude.write_text("# project v2\n")
        self.project_settings.write_text('{"enabledPlugins": {}}\n')
        self.start(source="clear")
        out = self.prompt()
        self.assertIn(".claude/settings.json", out["systemMessage"])
        self.assertNotIn("CLAUDE.md", out["systemMessage"])

    def test_new_project_instruction_file_counts_as_change(self):
        self.start()
        (self.project / "AGENTS.md").write_text("new\n")
        self.assertIn("AGENTS.md", self.prompt()["systemMessage"])

    def missing_baseline_prompt(self, process_age, edit_age):
        """No SessionStart record (plugin loaded mid-session): only the first prompt runs."""
        transcript = Path(self.tmp.name) / "t.jsonl"
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 86400))
        transcript.write_text(json.dumps({"timestamp": stamp}) + "\n")
        past = time.time() - 86400
        os.utime(transcript, (past, past))
        for path in stale.watched_files(self.project, self.home):
            if Path(path).exists():
                os.utime(path, (past, past))
        self.agents.write_text("# changed\n")
        edited = time.time() - edit_age
        os.utime(self.agents, (edited, edited))
        ps = NO_DAEMONS
        if process_age is not None:
            started = time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(time.time() - process_age))
            ps = lambda: (f"  500 1 {started}     /Users/x/.local/bin/claude --resume\n"  # noqa: E731
                          f"  600 500 {started}     /bin/sh -c python3 hook\n")
        event = self.event("UserPromptSubmit", prompt="hi", transcript_path=str(transcript))
        first = stale.handle(event, self.env, ps=ps, ppid=600)
        return first, stale.handle(event, self.env, ps=ps, ppid=600)

    def test_missing_baseline_warns_for_changes_after_process_start(self):
        first, second = self.missing_baseline_prompt(process_age=7200, edit_age=60)
        self.assertIn("AGENTS.md", first["systemMessage"])
        self.assertNotIn("settings.json", first["systemMessage"])
        self.assertEqual(second, {})

    def test_resumed_session_without_baseline_is_silent_for_changes_before_process_start(self):
        first, second = self.missing_baseline_prompt(process_age=600, edit_age=3600)
        self.assertEqual(first, {})
        self.assertEqual(second, {})

    def test_missing_baseline_without_claude_process_is_silent(self):
        first, second = self.missing_baseline_prompt(process_age=None, edit_age=60)
        self.assertEqual(first, {})
        self.assertEqual(second, {})

    def test_stale_daemon_flagged_once_at_session_start(self):
        old = time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(time.time() - 7200))
        ps = lambda: (f"  4242 1 {old}     /Users/x/.local/bin/claude daemon run\n"  # noqa: E731
                      f"  4243 1 {old}     /usr/bin/vim daemon.txt\n")
        self.assertEqual(self.start(ps=ps), {})
        out = self.prompt()
        self.assertIn("4242", out["systemMessage"])
        self.assertIn("claude daemon stop", out["systemMessage"])
        self.assertNotIn("4243", out["systemMessage"])
        self.assertEqual(self.prompt(), {})
        self.start(ps=ps)
        self.assertEqual(self.prompt(), {})

    def test_shell_mentioning_daemon_is_not_a_daemon(self):
        old = time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(time.time() - 7200))
        self.assertEqual(stale.daemons(f"  77 1 {old}     /bin/zsh -c echo hi; claude daemon stop\n"), [])
        self.assertEqual(len(stale.daemons(f"  78 1 {old}     node /opt/claude daemon run\n")), 1)

    def test_fresh_daemon_not_flagged(self):
        now = time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(time.time() + 60))
        self.start(ps=lambda: f"  4242 1 {now}     claude daemon run\n")
        self.assertEqual(self.prompt(), {})

    def test_clear_with_new_session_id_still_flags_settings_changed_since_process_start(self):
        old = time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(time.time() - 7200))
        past = time.time() - 3600
        for path in stale.watched_files(self.project, self.home):
            if Path(path).exists():
                os.utime(path, (past, past))
        self.user_settings.write_text('{"enabledPlugins": {"x@y": true}}\n')
        ps = lambda: (f"  500 1 {old}     /Users/x/.local/bin/claude --resume\n"  # noqa: E731
                      f"  600 500 {old}     /bin/sh -c python3 hook\n")
        event = self.event("SessionStart", source="clear", session_id="s2")
        self.assertEqual(stale.handle(event, self.env, ps=ps, ppid=600), {})
        out = stale.handle(self.event("UserPromptSubmit", session_id="s2"), self.env, ps=NO_DAEMONS)
        self.assertIn("~/.claude/settings.json", out["systemMessage"])
        self.assertNotIn("CLAUDE.md", out["systemMessage"])

    def clear_after_edit(self, settings, source="clear"):
        """First SessionStart in a claude process, a settings edit, then /clear (new session id).
        source=None skips the second SessionStart, as when the hook loads mid-session."""
        old = time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(time.time() - 7200))
        past = time.time() - 10800
        for path in stale.watched_files(self.project, self.home):
            if Path(path).exists():
                os.utime(path, (past, past))
        ps = lambda: (f"  500 1 {old}     /Users/x/.local/bin/claude\n"  # noqa: E731
                      f"  600 500 {old}     /bin/sh -c python3 hook\n")
        stale.handle(self.event("SessionStart", source="startup"), self.env, ps=ps, ppid=600)
        self.user_settings.write_text(settings)
        if source:
            event = self.event("SessionStart", source=source, session_id="s2")
            self.assertEqual(stale.handle(event, self.env, ps=ps, ppid=600), {})
        return stale.handle(self.event("UserPromptSubmit", session_id="s2"), self.env, ps=ps, ppid=600)

    def test_clear_after_permissions_only_edit_is_silent(self):
        self.assertEqual(self.clear_after_edit('{"permissions": {"allow": ["Bash(ls)"]}}\n'), {})

    def test_mid_session_load_reuses_process_baseline(self):
        self.assertEqual(self.clear_after_edit('{"permissions": {"deny": ["Bash(pwd)"]}}\n', source=None), {})

    def process_ps(self):
        old = time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(time.time() - 7200))
        return lambda: (f"  500 1 {old}     /Users/x/.local/bin/claude\n"  # noqa: E731
                        f"  600 500 {old}     /bin/sh -c python3 hook\n")

    def session(self, session_id, source="clear"):
        ps = self.process_ps()
        if source:
            stale.handle(self.event("SessionStart", source=source, session_id=session_id), self.env, ps=ps, ppid=600)
        return stale.handle(self.event("UserPromptSubmit", session_id=session_id), self.env, ps=ps, ppid=600)

    def test_unknown_change_warns_once_per_process(self):
        """Hook loaded mid-session with no process baseline: an edit since process start is unknown."""
        past = time.time() - 10800
        for path in stale.watched_files(self.project, self.home):
            if Path(path).exists():
                os.utime(path, (past, past))
        self.user_settings.write_text('{"permissions": {"allow": ["Bash(ls)"]}}\n')
        self.assertIn("~/.claude/settings.json", self.session("s2", source=None)["systemMessage"])
        self.assertEqual(self.session("s3"), {})
        self.assertEqual(self.session("s4"), {})

    def test_warned_change_does_not_rewarn_after_clear(self):
        out = self.clear_after_edit('{"enabledPlugins": {"x@y": true}}\n')
        self.assertIn("/reload-plugins", out["systemMessage"])
        self.assertEqual(self.session("s3"), {})
        self.user_settings.write_text('{"enabledPlugins": {"x@y": false}}\n')
        self.assertIn("/reload-plugins", self.session("s4")["systemMessage"])

    def test_settings_file_created_after_start_warns_after_clear(self):
        self.session("s1", source="startup")
        local = self.project / ".claude/settings.local.json"
        local.write_text('{"enabledPlugins": {"x@y": true}}\n')
        self.assertIn("settings.local.json", self.session("s2")["systemMessage"])

    def test_settings_file_created_without_frozen_keys_is_silent(self):
        """Onboarding writes ~/.claude/settings.json with a theme; "always allow" creates
        settings.local.json. Neither touches enabledPlugins (seen live on 2.1.311)."""
        self.user_settings.unlink()
        self.start()
        self.user_settings.write_text('{"theme": "dark"}\n')
        (self.project / ".claude/settings.local.json").write_text('{"permissions": {"allow": ["Bash(ls)"]}}\n')
        self.assertEqual(self.prompt(), {})

    def test_settings_file_deleted_without_frozen_keys_is_silent(self):
        self.start()
        self.project_settings.unlink()
        self.assertEqual(self.prompt(), {})

    def test_settings_file_created_with_frozen_key_warns(self):
        self.user_settings.unlink()
        self.start()
        self.user_settings.write_text('{"enabledPlugins": {"x@y": true}}\n')
        self.assertIn("/reload-plugins", self.prompt()["systemMessage"])

    def test_missing_settings_from_older_state_does_not_warn(self):
        self.project_settings.unlink()
        self.start()
        state_path = self.data / "stale-config/s1.json"
        state = stale.load(state_path)
        state["files"][str(self.project_settings)]["hash"] = None
        stale.save(state_path, state)
        self.project_settings.write_text('{"env": {"A": "1"}}\n')
        self.assertEqual(self.prompt(), {})

    def test_project_mcp_server_added_warns_with_restart(self):
        self.start()
        (self.project / ".mcp.json").write_text('{"mcpServers": {"x": {"command": "x"}}}\n')
        out = self.prompt()
        self.assertIn(".mcp.json", out["systemMessage"])
        self.assertIn("restart", out["systemMessage"])
        self.assertNotIn("/reload-plugins", out["systemMessage"])
        self.assertEqual(self.prompt(), {})

    def test_user_claude_json_counts_only_mcp_servers(self):
        claude_json = self.home / ".claude.json"
        claude_json.write_text(json.dumps({"numStartups": 1, "projects": {str(self.project): {}}}))
        self.start()
        claude_json.write_text(json.dumps({"numStartups": 2, "tipsHistory": {"a": 1},
                                           "projects": {str(self.project): {"lastCost": 3}}}))
        self.assertEqual(self.prompt(), {})
        claude_json.write_text(json.dumps({"numStartups": 3, "projects": {
            str(self.project): {"mcpServers": {"x": {"command": "x"}}}}}))
        self.assertIn("~/.claude.json", self.prompt()["systemMessage"])
        claude_json.write_text(json.dumps({"numStartups": 4, "mcpServers": {"y": {"command": "y"}},
            "projects": {str(self.project): {"mcpServers": {"x": {"command": "x"}}}}}))
        self.assertIn("~/.claude.json", self.prompt()["systemMessage"])

    def test_other_projects_mcp_servers_are_ignored(self):
        claude_json = self.home / ".claude.json"
        claude_json.write_text("{}")
        self.start()
        claude_json.write_text(json.dumps({"projects": {"/elsewhere": {"mcpServers": {"x": {}}}}}))
        self.assertEqual(self.prompt(), {})

    def test_claude_json_rewritten_after_process_start_is_not_unknown(self):
        (self.home / ".claude.json").write_text("{}")
        out = self.clear_after_edit('{"permissions": {"deny": ["Bash(pwd)"]}}\n', source=None)
        self.assertEqual(out, {})

    def test_rules_and_inline_and_nested_imports_are_watched(self):
        rule = self.project / ".claude/rules/frontend/style.md"
        rule.parent.mkdir(parents=True)
        rule.write_text("rule\n")
        user_rule = self.home / ".claude/rules/mine.md"
        user_rule.parent.mkdir(parents=True)
        user_rule.write_text("rule\n")
        self.project_claude.write_text("Follow @docs/extra.md for colours, see `@not/code.md`,\n"
                                       "mail me@example.com.\n```\n@not/fenced.md\n```\n")
        (self.project / "docs").mkdir()
        (self.project / "docs/extra.md").write_text("More in @deeper.md.\n")
        watched = stale.watched_files(self.project, self.home)
        for path in (rule, user_rule, self.project / "docs/extra.md", self.project / "docs/deeper.md"):
            with self.subTest(path=path.name):
                self.assertEqual(watched.get(str(path)), "instructions")
        for name in ("not/code.md", "not/fenced.md", "example.com"):
            with self.subTest(name=name):
                self.assertFalse(any(p.endswith(name) for p in watched))
        self.start()
        rule.write_text("rule v2\n")
        self.assertIn("style.md", self.prompt()["systemMessage"])

    def test_clear_after_live_key_edits_is_silent(self):
        self.assertEqual(self.clear_after_edit('{"hooks": {"Stop": []}, "env": {"A": "1"}}\n'), {})

    def test_clear_after_frozen_key_edit_warns(self):
        out = self.clear_after_edit('{"enabledPlugins": {"x@y": true}}\n')
        self.assertIn("~/.claude/settings.json", out["systemMessage"])
        self.assertIn("/reload-plugins", out["systemMessage"])

    def test_baseline_from_older_key_set_is_silent(self):
        self.start()
        state_path = self.data / "stale-config/s1.json"
        state = stale.load(state_path)
        entry = state["files"][str(self.user_settings)]
        entry.update(hash="old-key-set-hash")
        entry.pop("keys")
        stale.save(state_path, state)
        self.user_settings.write_text('{"permissions": {"allow": ["Bash(ls)"]}}\n')
        self.assertEqual(self.prompt(), {})
        self.user_settings.write_text('{"enabledPlugins": {"x@y": true}}\n')
        self.assertIn("settings.json", self.prompt()["systemMessage"])

    def test_daemon_ignores_project_file_changes(self):
        old = time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(time.time() - 7200))
        past = time.time() - 10800
        for path in stale.watched_files(self.project, self.home):
            if Path(path).exists():
                os.utime(path, (past, past))
        self.project_claude.write_text("# project edit\n")
        self.start(ps=lambda: f"  4242 1 {old}     claude daemon run\n")
        self.assertEqual(self.prompt(), {})

    def test_touched_but_identical_file_is_hashed_once(self):
        self.start()
        later = time.time() + 5
        os.utime(self.user_settings, (later, later))
        calls = []
        original = stale.digest
        stale.digest = lambda path, *rest: calls.append(path) or original(path, *rest)
        try:
            self.assertEqual(self.prompt(), {})
            self.assertEqual(self.prompt(), {})
        finally:
            stale.digest = original
        self.assertEqual(calls, [str(self.user_settings)])

    def test_settings_only_flag_startup_frozen_keys(self):
        self.start()
        self.project_settings.write_text('{"permissions": {"allow": ["Bash(ls)"]}, "hooks": {}, "env": {}}\n')
        self.assertEqual(self.prompt(), {})
        self.project_settings.write_text('{"permissions": {}, "enabledPlugins": {"x@y": true}}\n')
        self.assertIn(".claude/settings.json", self.prompt()["systemMessage"])

    def test_daemon_memory_drops_old_entries(self):
        old = time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(time.time() - 7200))
        stale.save(self.data / "stale-config/daemons.json", {"1:1": time.time() - stale.PRUNE_AFTER_SECONDS - 1})
        self.user_settings.write_text('{"hooks": {}}\n')
        self.start(ps=lambda: f"  4242 1 {old}     claude daemon run\n")
        self.assertEqual(list(stale.load(self.data / "stale-config/daemons.json")), [f"4242:{stale.stat_key(str(self.user_settings))[0]}"])

    def test_bad_input_fails_open(self):
        for raw in (b"", b"not json", b"[]", b"{}", b'{"hook_event_name": "UserPromptSubmit"}'):
            with self.subTest(raw=raw):
                result = subprocess.run([sys.executable, str(SCRIPT)], input=raw, capture_output=True,
                                        timeout=5, env={**os.environ, **self.env})
                self.assertEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout), {})

    def test_cli_round_trip_under_50ms_when_unchanged(self):
        env = {**os.environ, **self.env}
        run = lambda e: subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(e).encode(),  # noqa: E731
                                       capture_output=True, timeout=5, env=env, check=True)
        run(self.event("SessionStart", source="startup"))
        timings = []
        for _ in range(5):
            began = time.perf_counter()
            result = run(self.event("UserPromptSubmit", prompt="hi"))
            timings.append(time.perf_counter() - began)
            self.assertEqual(json.loads(result.stdout), {})
        self.assertLess(min(timings), 0.05)

    def test_plugin_registers_hooks(self):
        config = json.loads(HOOKS_JSON.read_text())["hooks"]
        for name in ("SessionStart", "UserPromptSubmit"):
            command = config[name][0]["hooks"][0]["command"]
            self.assertIn("${CLAUDE_PLUGIN_ROOT}/hooks/stale-config.py", command)


    def test_band_freezes_the_same_settings_and_size_limit(self):
        band = (SCRIPT.parent / "session-health.tsx").read_text()
        keys = re.search(r"export const FROZEN_SETTINGS = \[(.*?)\]", band).group(1)
        self.assertEqual(tuple(re.findall(r"'([^']+)'", keys)), stale.FROZEN_SETTINGS)
        limit = re.search(r"const MAX_CLAUDE_JSON = ([0-9_]+)", band).group(1)
        self.assertEqual(int(limit.replace("_", "")), stale.MAX_CLAUDE_JSON)

if __name__ == "__main__":
    unittest.main()
