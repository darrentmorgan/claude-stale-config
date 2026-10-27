# stale-config

A Claude Code plugin that tells a running session when its config went stale on disk, and names the fix.

Claude Code reads some config once, when a session starts. If you edit that config later, the session keeps running on the old version and gives no warning. This plugin records a hash of each watched file when the session starts. On every prompt it checks the files again. When something the session can't pick up by itself has changed, you get one warning:

```
Stale config. MCP servers in .mcp.json changed. They load only at start: restart the session (claude --continue) to use them.
```

## What actually reloads (tested, not assumed)

Checked live on Claude Code 2.1.311: a multi-turn session, a file changed between turns, then the model asked what it can see.

| Change mid-session | Terminal session | Headless (`-p`, SDK) | This plugin says |
| --- | --- | --- | --- |
| `CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`, `@imports` | reloads | **stays old** | re-read it (Claude does it on that prompt) |
| `enabledPlugins` in settings | **stays old** | **stays old** | run `/reload-plugins` |
| MCP servers (`.mcp.json`, `~/.claude.json`) | **stays old**, even in `/mcp` | **stays old** | restart (`claude --continue`) |
| `hooks` in settings | reloads | stays old | nothing |
| `env`, `permissions` in settings | reloads | reloads | nothing |

The table holds for one version only. Claude Code changes fast, so the hook encodes these results and its tests pin them.

## Install

```
/plugin marketplace add darrentmorgan/claude-stale-config
/plugin install stale-config@stale-config
```

Sessions that were already open before the install never run the hook. Restart those once.

## Details

- **Watched:** `~/.claude/settings.json`, the project's `.claude/settings.json` and `settings.local.json`, and `.mcp.json`. It also watches the `mcpServers` in `~/.claude.json`, at user scope and this project's local scope. Then every `CLAUDE.md`, `CLAUDE.local.md` and `.claude/CLAUDE.md` from the project up to `~`, the project's `AGENTS.md`, `~/.agents/AGENTS.md` if you have one, and the rules folders. Last, every file those `@import`, anywhere in a line but not in code, up to five levels deep.
- **Only what's frozen counts.** In settings files it hashes only `enabledPlugins`. In MCP files it hashes only `mcpServers`. So when Claude Code writes your theme, a permission or its own stats, you get no warning. A settings file that didn't exist counts as an empty one.
- **Once per change.** After it warns about a change, it stays quiet until the file changes again. A file that is touched but has the same content is not a change.
- **`/clear` and compaction** reload instruction files but not settings. Settings are compared with the baseline from the claude process's first session.
- **`claude daemon`:** if the daemon started before your latest user-level change, its spare sessions run the old config. The plugin flags it once, with `claude daemon stop --any`.
- **Cost:** it is stdlib Python with no dependencies, and takes about 35 ms per prompt when nothing changed. `~/.claude.json` over 8 MB is skipped.
- **Fails open.** Any error gives `{}` and the session carries on. State goes in the plugin data folder and is pruned after 30 days.

## Limits

- In a terminal session, the instruction notice is a courtesy. Claude Code already has the new text.
- Headless sessions keep their start-up `hooks`. This is not flagged, because a headless session can't reload them either.
- Process detection uses `ps`. On Windows the daemon check and the per-process baseline are skipped.

## Tests

```
python3 -m pytest tests
```

MIT licensed.
