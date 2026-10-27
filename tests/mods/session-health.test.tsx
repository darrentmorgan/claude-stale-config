import { expect, test } from 'claude-code/testing'

import { changeLine, diffLines, frozen, pairRows, staleHint, staleTitle, updateLine, wordDiff } from '../../hooks/session-health'

const SETTINGS = '/h/.claude/settings.json'
const INSTALLED = '/h/.claude/plugins/installed_plugins.json'
const MCP = '/p/.mcp.json'
const CLAUDE_JSON = '/h/.claude.json'
const AGENTS = '/p/AGENTS.md'

// `plugins` adds entries to enabledPlugins, the one frozen setting.
const settings = (extra: string, plugins = '') =>
  `{\n  "enabledPlugins": { "stale-config@stale-config": true${plugins} },\n  "model": "opus"${extra}\n}`
const installed = (sha: string, version = sha) =>
  JSON.stringify({
    version: 2,
    plugins: { 'stale-config@stale-config': [{ scope: 'user', version, gitCommitSha: sha }] },
  })
const mcp = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers }, null, 2)

const REFUSED = "Plugins can't be reloaded over a remote connection."

const BAND = (surface: 'terminal' | 'desktop', isWorking = false) =>
  ({
    plugin: 'stale-config',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking,
      maxRows: 10,
      bodyColumns: 120,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  }) as const

const PROMPT = { text: 'hi', wait: false, origin: { kind: 'composer' } } as const

function fakeFs(
  on: any,
  files: Record<string, string>,
  mtimes: Record<string, number>,
  below = '',
  clock: { now: number } = { now: 1_700_000_000_000 },
  sizes: Record<string, number> = {},
) {
  // Stands for the engine and any other mod drawing in the band.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{below}</Text>
  })
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('fs.stat', (_: unknown, e: { path: string }) => {
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: sizes[e.path] ?? 1, mtimeMs: mtimes[e.path] ?? 1, isLink: false } }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('clock.now', () => ({ value: clock.now }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
}

async function edit(files: Record<string, string>, mtimes: Record<string, number>, path: string, text: string) {
  files[path] = text
  mtimes[path] = (mtimes[path] ?? 1) + 1
}

test('all clear draws nothing', async ($, on) => {
  const files = { [SETTINGS]: settings(''), [INSTALLED]: installed('aaaaaaa') }
  fakeFs(on, files, {})
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(BAND(surface))
    expect(await ui.find({ type: 'Button' })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /Stale|changed|updated/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('an MCP server added to .mcp.json shows a stale band that says restart, with no Reload', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings(''), [INSTALLED]: installed('aaaaaaa') }
  const mtimes: Record<string, number> = {}
  fakeFs(on, files, mtimes)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, MCP, mcp({ docs: { command: 'npx', args: ['docs-mcp'] } }))
  await $.prompt.submit(PROMPT)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(BAND(surface))
    expect(await ui.find({ type: 'Text', text: 'Stale session.' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: '.mcp.json changed after this session started.' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /restart with claude --continue/ })).toBeTruthy()
    expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['Changes', 'Dismiss', 'Snooze 30 min'])
    await ui.unmount()
  }
})

test('an .mcp.json edit outside mcpServers draws nothing', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings(''), [MCP]: mcp({ a: { command: 'x' } }) }
  const mtimes: Record<string, number> = { [MCP]: 1 }
  fakeFs(on, files, mtimes)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, MCP, JSON.stringify({ $schema: 'x', mcpServers: { a: { command: 'x' } } }))
  await $.prompt.submit(PROMPT)
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /Stale|changed/ })).toBeFalsy()
  await ui.unmount()
})

test("~/.claude.json counts only its user and this project's MCP servers", async ($, on) => {
  const at = (o: object) => JSON.stringify({ numStartups: 1, ...o })
  const files: Record<string, string> = { [SETTINGS]: settings(''), [CLAUDE_JSON]: at({}) }
  const mtimes: Record<string, number> = { [CLAUDE_JSON]: 1 }
  fakeFs(on, files, mtimes)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  // Claude Code's own stats, and a server for another project: no change here.
  await edit(files, mtimes, CLAUDE_JSON, at({ numStartups: 9, projects: { '/other': { mcpServers: { o: { command: 'o' } } } } }))
  await $.prompt.submit(PROMPT)
  let ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBeFalsy()
  await ui.unmount()

  await edit(files, mtimes, CLAUDE_JSON, at({ projects: { '/p': { mcpServers: { local: { command: 'l' } } } } }))
  await $.prompt.submit(PROMPT)
  ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: 'MCP servers in ~/.claude.json changed after this session started.' })).toBeTruthy()
  await ui.unmount()
})

test('a ~/.claude.json over 8 MB is skipped', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings(''), [CLAUDE_JSON]: '{}' }
  const mtimes: Record<string, number> = { [CLAUDE_JSON]: 1 }
  fakeFs(on, files, mtimes, '', undefined, { [CLAUDE_JSON]: 9_000_000 })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, CLAUDE_JSON, mcp({ big: { command: 'b' } }))
  await $.prompt.submit(PROMPT)
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBeFalsy()
  await ui.unmount()
})

test('an enabledPlugins change offers Reload, which loads it and clears the band', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings(''), [INSTALLED]: installed('aaaaaaa') }
  const mtimes: Record<string, number> = { [SETTINGS]: 1 }
  fakeFs(on, files, mtimes)
  const ran: string[] = []
  on('command.run', (_: unknown, e: { command: string }) => (ran.push(e.command), { text: 'Reloaded: 2 plugins' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, SETTINGS, settings('', ', "other@x": true'))
  await $.prompt.submit(PROMPT)

  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: 'settings.json changed after this session started.' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'Reload loads plugins, hooks and settings.' })).toBeTruthy()
  await ui.press({ key: 'reload' })
  expect(ran).toEqual(['reload-plugins'])
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBeFalsy()
  await ui.unmount()
})

test('a permissions, env or hooks edit draws nothing: those apply live', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings('') }
  const mtimes: Record<string, number> = { [SETTINGS]: 1 }
  fakeFs(on, files, mtimes)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, SETTINGS, settings(',\n  "permissions": { "allow": ["Bash(pwd)"] },\n  "env": { "X": "1" },\n  "hooks": {}'))
  await $.prompt.submit(PROMPT)
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Button' })).toBeFalsy()
  await ui.unmount()
})

test('settings and MCP together: Reload for one, restart named for the other', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings('') }
  const mtimes: Record<string, number> = { [SETTINGS]: 1 }
  fakeFs(on, files, mtimes)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, SETTINGS, settings('', ', "other@x": true'))
  await edit(files, mtimes, MCP, mcp({ docs: { command: 'd' } }))
  await $.prompt.submit(PROMPT)
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: 'settings.json changed and .mcp.json changed after this session started.' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'reload' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Reload loads plugins.*restart with claude --continue/ })).toBeTruthy()
  await ui.unmount()
})

test('a refused reload says to type the command and offers no second Reload', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings('') }
  const mtimes: Record<string, number> = { [SETTINGS]: 1 }
  fakeFs(on, files, mtimes)
  on('command.run', () => ({ text: REFUSED }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, SETTINGS, settings('', ', "other@x": true'))
  await $.prompt.submit(PROMPT)
  const ui = await $.ui.mount(BAND('terminal'))
  await ui.press({ key: 'reload' })
  expect(await ui.find({ type: 'Text', text: /didn't run here. Type \/reload-plugins/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'reload' })).toBeFalsy()
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBeFalsy()
  await ui.unmount()
})

test('a reload with no proof waits, then gives up at the deadline', async ($, on) => {
  const clock = { now: 1_700_000_000_000 }
  const files: Record<string, string> = { [SETTINGS]: settings('') }
  const mtimes: Record<string, number> = { [SETTINGS]: 1 }
  fakeFs(on, files, mtimes, '', clock)
  on('command.run', () => ({ text: 'Queued' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, SETTINGS, settings('', ', "other@x": true'))
  await $.prompt.submit(PROMPT)
  let ui = await $.ui.mount(BAND('terminal'))
  await ui.press({ key: 'reload' })
  expect(await ui.find({ type: 'Text', text: 'Reload sent. Waiting for it to finish.' })).toBeTruthy()
  await ui.unmount()
  clock.now += 4 * 60 * 1000
  await $.prompt.submit(PROMPT)
  ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /didn't run here/ })).toBeTruthy()
  await ui.unmount()
})

test('in a desktop (non-interactive) session Reload fills in /reload-plugins', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings('') }
  const mtimes: Record<string, number> = { [SETTINGS]: 1 }
  fakeFs(on, files, mtimes)
  const box = { text: '' }
  on('prompt.read', () => ({ value: { text: box.text } }))
  on('prompt.fill', (_: unknown, e: { text: string }) => ((box.text = e.text), { isFilled: true }))
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: false })
  await edit(files, mtimes, SETTINGS, settings('', ', "other@x": true'))
  await $.prompt.submit(PROMPT)
  const ui = await $.ui.mount(BAND('desktop'))
  expect(await ui.find({ type: 'Text', text: /Reload fills in \/reload-plugins/ })).toBeTruthy()
  await ui.press({ key: 'reload' })
  expect(box.text).toBe('/reload-plugins')
  expect(await ui.find({ type: 'Text', text: 'Press Return to run /reload-plugins.' })).toBeTruthy()
  await ui.unmount()
})

test('a typed /reload-plugins loads settings but leaves an MCP change showing', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings('') }
  const mtimes: Record<string, number> = { [SETTINGS]: 1 }
  fakeFs(on, files, mtimes)
  on('command.run', () => ({ text: 'Reloaded: 2 plugins' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, SETTINGS, settings('', ', "other@x": true'))
  await edit(files, mtimes, MCP, mcp({ docs: { command: 'd' } }))
  await $.prompt.submit(PROMPT)
  await $.command.run({ command: 'reload-plugins', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: '.mcp.json changed after this session started.' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'reload' })).toBeFalsy()
  await ui.unmount()
})

test('an instruction-only change is a quiet notice that clears after the next turn', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings(''), [AGENTS]: 'old' }
  const mtimes: Record<string, number> = { [AGENTS]: 1 }
  fakeFs(on, files, mtimes)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, AGENTS, 'new')
  await $.prompt.submit(PROMPT)
  let ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: 'Instructions changed.' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'AGENTS.md changed. This session re-reads it on your next message.' })).toBeTruthy()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['Changes', 'Dismiss'])
  await ui.unmount()

  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /Instructions changed/ })).toBeFalsy()
  await ui.unmount()
})

test('Dismiss hides a change until the file changes again', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings('') }
  const mtimes: Record<string, number> = {}
  fakeFs(on, files, mtimes)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, MCP, mcp({ a: { command: 'a' } }))
  await $.prompt.submit(PROMPT)
  let ui = await $.ui.mount(BAND('terminal'))
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBeFalsy()
  await ui.unmount()

  mtimes[MCP] = 10
  await $.prompt.submit(PROMPT)
  ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBeFalsy()
  await ui.unmount()

  await edit(files, mtimes, MCP, mcp({ a: { command: 'a' }, b: { command: 'b' } }))
  await $.prompt.submit(PROMPT)
  ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBeTruthy()
  await ui.unmount()
})

test('Snooze hides the band for 30 minutes, then it waits for the turn to end', async ($, on) => {
  const clock = { now: 1_700_000_000_000 }
  const files: Record<string, string> = { [SETTINGS]: settings('') }
  const mtimes: Record<string, number> = {}
  fakeFs(on, files, mtimes, '', clock)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, MCP, mcp({ a: { command: 'a' } }))
  await $.prompt.submit(PROMPT)
  let ui = await $.ui.mount(BAND('terminal'))
  await ui.press({ key: 'later' })
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBeFalsy()
  await ui.unmount()
  clock.now += 31 * 60 * 1000
  ui = await $.ui.mount(BAND('terminal', true))
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBeFalsy()
  await ui.unmount()
  ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBeTruthy()
  await ui.unmount()
})

test('a plugin update alone draws no band; beside a settings change it is named', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings(''), [INSTALLED]: installed('aaaaaaa', '1.0.0') }
  const mtimes: Record<string, number> = { [SETTINGS]: 1 }
  fakeFs(on, files, mtimes)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  files[INSTALLED] = installed('bbbbbbb', '1.1.0')
  await $.prompt.submit(PROMPT)
  let ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Button' })).toBeFalsy()
  await ui.unmount()

  await edit(files, mtimes, SETTINGS, settings('', ', "other@x": true'))
  await $.prompt.submit(PROMPT)
  ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /Also updated: stale-config 1.0.0 to 1.1.0\./ })).toBeTruthy()
  await ui.unmount()
})

test('the band stacks above what another mod draws there', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings('') }
  const mtimes: Record<string, number> = {}
  fakeFs(on, files, mtimes, 'OTHER MOD')
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, MCP, mcp({ a: { command: 'a' } }))
  await $.prompt.submit(PROMPT)
  const ui = await $.ui.mount(BAND('terminal'))
  expect(await ui.find({ type: 'Text', text: /Stale session/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /OTHER MOD/ })).toBeTruthy()
  await ui.unmount()
})

test('Changes opens a pane with the MCP servers diff', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: settings(''), [MCP]: mcp({ a: { command: 'a' } }) }
  const mtimes: Record<string, number> = { [MCP]: 1 }
  fakeFs(on, files, mtimes)
  const opened: any[] = []
  on('ui.open', (_: unknown, e: any) => (opened.push(e), { value: { isPlaced: true } }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await edit(files, mtimes, MCP, mcp({ a: { command: 'a' }, docs: { command: 'npx' } }))
  await $.prompt.submit(PROMPT)
  const band = await $.ui.mount(BAND('terminal'))
  await band.press({ key: 'changes' })
  expect(opened[0]?.id).toBe('stale-config-diff')
  await band.unmount()

  const pane = await $.ui.mount({ plugin: 'stale-config', surface: 'terminal', component: 'Pane', requestId: 'stale-config-diff', props: { columns: 120, rows: 40 } } as any)
  expect(await pane.find({ type: 'Text', text: /What changed since this session started/ })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /"docs": \{/ })).toBeTruthy()
  await pane.unmount()
})

test('frozen keeps only what loads at start, sorted', () => {
  expect(frozen(null, 'settings')).toBe('{}')
  expect(frozen('{"theme":"dark"}', 'settings')).toBe('{}')
  expect(frozen('{"enabledPlugins":{"b":true,"a":true}}', 'settings')).toBe('{\n  "enabledPlugins": {\n    "a": true,\n    "b": true\n  }\n}\n')
  expect(frozen('{"mcpServers":{}}', 'mcp')).toBe('{}')
  expect(frozen('not json', 'mcp')).toBe('not json')
  expect(frozen('anything', 'instructions')).toBe('anything')
})

test('the helpers read as plain sentences', () => {
  expect(staleTitle(0, [])).toBe('')
  expect(staleTitle(1, [])).toBe('Stale session.')
  expect(staleTitle(0, [{ id: 'a@x' }, { id: 'b@x' }])).toBe('2 plugins updated.')
  expect(changeLine([{ label: '.mcp.json', status: 'added' }])).toBe('.mcp.json was added after this session started.')
  expect(staleHint([{ kind: 'instructions' }], { interactive: true, reload: false })).toBe('')
  expect(updateLine({ id: 'x@y', from: 'aaaaaaa', to: 'bbbbbbb' })).toBe('x aaaaaaa to bbbbbbb')
})

test('the diff pairs a changed line with its replacement, word by word', () => {
  const lines = diffLines('a\n  "x": 1\nb\n', 'a\n  "x": 2\nb\n')
  expect(lines.filter(l => l.kind === 'add').length).toBe(1)
  const row = pairRows(lines).find(r => r.kind === 'row' && r.words)
  expect(row).toBeTruthy()
  expect(wordDiff('  "x": 1', '  "x": 2')?.right.filter(s => s.changed).map(s => s.text)).toEqual(['2'])
})
