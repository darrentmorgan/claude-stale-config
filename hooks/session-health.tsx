// The session-health band: a row above the prompt that says when this
// session's config went stale on disk, what changed, and the fix. The
// stale-config hook (stale-config.py) tells the model; this tells you.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, RenderInput, SessionCompactResult, ThemeKey } from 'claude-code'

import type { Baseline, Told, DiffLine, DiffRow, WordSeg, Dismissed, FileChange, Kind, PluginUpdate, PluginVersion } from '../types'

const PANE = 'stale-config-diff'
const SNOOZE_MS = 30 * 60 * 1000
// A few stats each time: cheap, and the band shows soon after an edit, before any prompt.
const CHECK_MS = 5 * 1000
const CONTEXT = 2
const MAX_LINES = 1500
// A reload with no proof it ran (a run queued behind a turn) gives up after this.
const RELOAD_MAX_MS = 3 * 60 * 1000
// ~/.claude.json is rewritten all the time and can grow large: past this it is
// skipped, as stale-config.py skips it.
const MAX_CLAUDE_JSON = 8_000_000

type Dollar = EngineInterface
type AbovePromptEvent = RenderInput<'AbovePrompt'>

const baseline = atom({ plugin: 'stale-config', key: 'baseline' } as const, null)
const plugins = atom({ plugin: 'stale-config', key: 'plugins' } as const, null)
const changes = atom({ plugin: 'stale-config', key: 'changes' } as const, [])
const updates = atom({ plugin: 'stale-config', key: 'updates' } as const, [])
const snoozeUntil = atom({ plugin: 'stale-config', key: 'snoozeUntil' } as const, 0)
const dismissed = atom({ plugin: 'stale-config', key: 'dismissed' } as const, { files: {}, plugins: {} } as Dismissed)
const checkedAt = atom({ plugin: 'stale-config', key: 'checkedAt' } as const, 0)
const pending = atom({ plugin: 'stale-config', key: 'pending' } as const, '' as '' | 'reload')
const reloadBlocked = atom({ plugin: 'stale-config', key: 'reloadBlocked' } as const, false)
// When an unproven reload started waiting; null while none waits.
const reloadWaitingSince = atom({ plugin: 'stale-config', key: 'reloadWaitingSince' } as const, null as number | null)
// A Reload press put /reload-plugins in the prompt box, until it runs.
const filled = atom({ plugin: 'stale-config', key: 'filled' } as const, false)
// The changed instruction files a prompt was sent with, as they read then: the
// stale-config hook told that turn to re-read them, so its end retires them.
// `skip` counts a turn that was already running when the prompt went in.
const told = atom({ plugin: 'stale-config', key: 'told' } as const, { files: {}, skip: 0 } as Told)

type Watched = { path: string; label: string; kind: Kind }
type Ctx = {
  home: string
  cwd: string
  watched: Watched[]
  mtimes: Record<string, number>
  isChecking: boolean
  isWorking: boolean
  isInteractive: boolean
  timers: { cancel: () => void }[]
}

function toLines(text: string): string[] {
  if (text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

// Line diff: LCS table, then hunks with CONTEXT lines either side.
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = toLines(oldText)
  const b = toLines(newText)
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [{ kind: 'gap', text: `File too large to diff (${a.length} to ${b.length} lines)` }]
  }
  const n = a.length
  const m = b.length
  const w = m + 1
  const lcs = new Array<number>((n + 1) * w).fill(0)
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const all: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    const x = a[i] ?? ''
    const y = b[j] ?? ''
    if (i < n && j < m && x === y) {
      all.push({ kind: 'same', text: x, a: i + 1, b: j + 1 })
      i++
      j++
    } else if (j < m && (i >= n || at(i, j + 1) >= at(i + 1, j))) {
      all.push({ kind: 'add', text: y, b: j + 1 })
      j++
    } else {
      all.push({ kind: 'del', text: x, a: i + 1 })
      i++
    }
  }
  const keep = all.map(() => false)
  all.forEach((line, k) => {
    if (line.kind === 'same') return
    for (let d = Math.max(0, k - CONTEXT); d <= Math.min(all.length - 1, k + CONTEXT); d++) keep[d] = true
  })
  const out: DiffLine[] = []
  let skipped = 0
  all.forEach((line, k) => {
    if (keep[k]) {
      if (skipped > 0) out.push({ kind: 'gap', text: `${skipped} unchanged lines` })
      skipped = 0
      out.push(line)
    } else {
      skipped++
    }
  })
  return out
}

// A paired line's words: runs of letters and digits, runs of spaces, and
// each punctuation mark alone. Each side spells its whole line.
const TOKEN = /[\p{L}\p{M}\p{N}_]+|\s+|[^\p{L}\p{M}\p{N}_\s]/gu
// Past this share of changed characters a pair reads as a rewrite: whole-line colour.
const WORD_MAX_CHANGED = 0.5
const WORD_MAX_CELLS = 40_000

// Token diff of a removed line against the line that replaced it, or null
// when they are too different (or too long) to be worth marking word by word.
export function wordDiff(oldText: string, newText: string): { left: WordSeg[]; right: WordSeg[] } | null {
  const ta = oldText.match(TOKEN) ?? []
  const tb = newText.match(TOKEN) ?? []
  // The shared start and end need no table; only the middle goes through the LCS.
  let head = 0
  while (head < ta.length && head < tb.length && ta[head] === tb[head]) head++
  let tail = 0
  while (tail < ta.length - head && tail < tb.length - head && ta[ta.length - 1 - tail] === tb[tb.length - 1 - tail]) tail++
  const a = ta.slice(head, ta.length - tail)
  const b = tb.slice(head, tb.length - tail)
  if ((a.length + 1) * (b.length + 1) > WORD_MAX_CELLS) return null
  const w = b.length + 1
  const lcs = new Array<number>((a.length + 1) * w).fill(0)
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const left: WordSeg[] = ta.slice(0, head).map(text => ({ text, changed: false }))
  const right: WordSeg[] = tb.slice(0, head).map(text => ({ text, changed: false }))
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      left.push({ text: a[i]!, changed: false })
      right.push({ text: b[j]!, changed: false })
      i++
      j++
    } else if (j < b.length && (i >= a.length || at(i, j + 1) >= at(i + 1, j))) {
      right.push({ text: b[j++]!, changed: true })
    } else {
      left.push({ text: a[i++]!, changed: true })
    }
  }
  for (const text of ta.slice(ta.length - tail)) left.push({ text, changed: false })
  for (const text of tb.slice(tb.length - tail)) right.push({ text, changed: false })
  // Spaces count for nothing: a rewrite that keeps its spaces is still a rewrite.
  const ink = (segs: WordSeg[], changed?: boolean) =>
    segs.reduce((n, s) => n + (changed === undefined || s.changed === changed ? s.text.replace(/\s/g, '').length : 0), 0)
  const total = ink(left) + ink(right)
  if (total === 0 || (ink(left, true) + ink(right, true)) / total > WORD_MAX_CHANGED) return null
  return { left: mergeSegs(left), right: mergeSegs(right) }
}

// A space between two changed words joins them; then neighbours of one kind merge.
function mergeSegs(segs: WordSeg[]): WordSeg[] {
  const marked = segs.map((s, k) =>
    !s.changed && /^\s+$/.test(s.text) && segs[k - 1]?.changed && segs[k + 1]?.changed ? { ...s, changed: true } : s,
  )
  const out: WordSeg[] = []
  for (const s of marked) {
    const last = out[out.length - 1]
    if (last && last.changed === s.changed) last.text += s.text
    else out.push({ ...s })
  }
  return out
}

// Side-by-side rows: an unchanged line sits on both sides; in each run of
// changes the removed lines pair with the added lines in order, with their
// word diff when the pair is close enough to have one.
export function pairRows(lines: DiffLine[]): DiffRow[] {
  const out: DiffRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const row: DiffRow = { kind: 'row' }
      if (dels[k]) row.left = dels[k]
      if (adds[k]) row.right = adds[k]
      const words = row.left && row.right ? wordDiff(row.left.text, row.right.text) : null
      if (words) row.words = words
      out.push(row)
    }
    dels = []
    adds = []
  }
  for (const l of lines) {
    if (l.kind === 'del') dels.push(l)
    else if (l.kind === 'add') adds.push(l)
    else {
      flush()
      out.push(l.kind === 'gap' ? { kind: 'gap', text: l.text } : { kind: 'row', left: l, right: l })
    }
  }
  flush()
  return out
}


async function readOrNull($: Dollar, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function readJson($: Dollar, path: string): Promise<any> {
  const text = await readOrNull($, path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// The version each enabled plugin is installed at, for this project.
async function pluginVersions($: Dollar, home: string, cwd: string): Promise<Record<string, PluginVersion>> {
  const settings = await readJson($, `${home}/.claude/settings.json`)
  const installed = await readJson($, `${home}/.claude/plugins/installed_plugins.json`)
  const enabled = settings?.enabledPlugins ?? {}
  const out: Record<string, PluginVersion> = {}
  for (const id of Object.keys(enabled)) {
    if (enabled[id] !== true) continue
    const entries: any[] = installed?.plugins?.[id] ?? []
    const entry = entries.find(x => x?.projectPath === cwd) ?? entries.find(x => x?.scope === 'user')
    const v = entry?.gitCommitSha ? String(entry.gitCommitSha).slice(0, 7) : entry?.version
    if (v) out[id] = { sha: String(v), version: entry?.version ? String(entry.version) : '' }
  }
  return out
}

// Settings keys frozen at session start; hooks, permissions and env apply live.
// Keep in step with FROZEN_SETTINGS in stale-config.py (a test checks).
export const FROZEN_SETTINGS = ['enabledPlugins']

// What counts in a watched file: an instruction file whole; in a settings or
// MCP file only what loads at start (enabledPlugins, mcpServers), as sorted
// JSON, so Claude Code writing a theme, a permission or its own stats is no
// change. A missing settings or MCP file sets nothing, the same as `{}`. Text
// that is not a JSON object compares whole, as stale-config.py does.
export function frozen(text: string | null, kind: Kind, project = '', isClaudeJson = false): string | null {
  if (kind === 'instructions') return text
  if (text === null) return '{}'
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text
  const part: Record<string, unknown> = {}
  if (kind === 'settings') {
    for (const k of FROZEN_SETTINGS) if (k in parsed) part[k] = parsed[k]
  } else {
    if (parsed.mcpServers && Object.keys(parsed.mcpServers).length > 0) part.mcpServers = parsed.mcpServers
    const local = isClaudeJson ? parsed.projects?.[project]?.mcpServers : undefined
    if (local && Object.keys(local).length > 0) part.projectMcpServers = local
  }
  const sorted = (v: any): any =>
    Array.isArray(v) ? v.map(sorted)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])]))
    : v
  // Pretty, so the diff pane shows the one server or plugin that changed.
  return Object.keys(part).length === 0 ? '{}' : JSON.stringify(sorted(part), null, 2) + '\n'
}

const isClaudeJson = (w: Pick<Watched, 'path'>) => /\/\.claude\.json$/.test(w.path)

// A watched file's counted content now, or undefined when it is too big to read.
async function content($: Dollar, ctx: Ctx, w: Watched, exists = true): Promise<string | null | undefined> {
  if (!exists) return frozen(null, w.kind)
  if (isClaudeJson(w)) {
    const size = await $.fs.stat(w.path).then(s => s.size, () => 0)
    if (size > MAX_CLAUDE_JSON) return undefined
  }
  return frozen(await readOrNull($, w.path), w.kind, ctx.cwd, isClaudeJson(w))
}

async function check($: Dollar, ctx: Ctx) {
  if (ctx.isChecking || !ctx.home) return
  ctx.isChecking = true
  try {
    await reloadExpired($)
    const base = await read($, baseline)
    if (base) {
      const found: FileChange[] = []
      for (const w of ctx.watched) {
        let mtime = -1
        try {
          mtime = (await $.fs.stat(w.path)).mtimeMs
        } catch {}
        const before = (await read($, changes)).find(c => c.path === w.path)
        // Unchanged since the last check, missing (-1) included.
        if (ctx.mtimes[w.path] === mtime) {
          if (before) found.push(before)
          continue
        }
        ctx.mtimes[w.path] = mtime
        const now = await content($, ctx, w, mtime !== -1)
        if (now === undefined) {
          if (before) found.push(before)
          continue
        }
        const then = w.path in base ? (base[w.path] ?? null) : frozen(null, w.kind)
        if (now === then) continue
        const lines = diffLines(then ?? '', now ?? '')
        found.push({
          path: w.path,
          label: w.label,
          kind: w.kind,
          status: then === null ? 'added' : now === null ? 'removed' : 'changed',
          added: lines.filter(l => l.kind === 'add').length,
          removed: lines.filter(l => l.kind === 'del').length,
          lines,
          text: now,
        })
      }
      // Read the dismissals last, so a Dismiss pressed mid-check still holds.
      const seen = await read($, dismissed)
      await update($, changes, () => found.filter(f => !(f.path in seen.files && seen.files[f.path] === f.text)))
    }
    const loaded = await read($, plugins)
    if (loaded) {
      const current = await pluginVersions($, ctx.home, ctx.cwd)
      const ups: PluginUpdate[] = Object.keys(current).flatMap(id => {
        const from = loaded[id]
        const to = current[id]
        return from?.sha && to?.sha && from.sha !== to.sha
          ? [{ id, from: from.sha, to: to.sha, fromVersion: from.version, toVersion: to.version }]
          : []
      })
      const seen = await read($, dismissed)
      await update($, updates, () => ups.filter(u => seen.plugins[u.id] !== u.to))
    }
    const t = await $.clock.now()
    await update($, checkedAt, () => t)
  } finally {
    ctx.isChecking = false
  }
}

// What each file now holds becomes the baseline for the kinds picked: what a
// reload or a re-read loaded.
async function snapshot($: Dollar, ctx: Ctx, kinds: Kind[]) {
  const snap = { ...((await read($, baseline)) ?? {}) }
  const paths: string[] = []
  for (const w of ctx.watched.filter(w => kinds.includes(w.kind))) {
    const now = await content($, ctx, w)
    if (now === undefined) continue
    snap[w.path] = now
    paths.push(w.path)
    delete ctx.mtimes[w.path]
  }
  await update($, baseline, () => snap)
  // Re-read now: a turn ending later must not put back the older text.
  await update($, told, cur => {
    const files = { ...cur.files }
    for (const path of paths) delete files[path]
    return { ...cur, files }
  })
  await check($, ctx)
}

// A prompt went in: note the changed instruction files as they read now. A
// slash command is no prompt to the model, so the hook tells it nothing.
async function noteTold($: Dollar, ctx: Ctx, text: string) {
  if (/^\s*\//.test(text)) return
  const base = await read($, baseline)
  if (!base) return
  // Read from disk: a check already running may not have stored its changes yet.
  const now: Baseline = {}
  for (const w of ctx.watched.filter(w => w.kind === 'instructions')) {
    const text = await readOrNull($, w.path)
    if (text !== (base[w.path] ?? null)) now[w.path] = text
  }
  await update($, told, () => ({ files: now, skip: ctx.isWorking ? 1 : 0 }))
}

// The main turn after that prompt ended: what it was told to re-read becomes
// the baseline, so the notice goes. A later edit differs and shows again.
async function retireTold($: Dollar, ctx: Ctx) {
  const was = await read($, told)
  if (Object.keys(was.files).length === 0) return
  if (was.skip > 0) return update($, told, cur => ({ ...cur, skip: cur.skip - 1 }))
  await update($, told, () => ({ files: {}, skip: 0 }))
  await update($, baseline, cur => ({ ...(cur ?? {}), ...was.files }))
  for (const path of Object.keys(was.files)) delete ctx.mtimes[path]
  await check($, ctx)
}

type Action = {
  key: string
  label: string
  variant?: 'primary' | 'secondary'
  plain?: true
  onPress: () => void
}

// The glyph's column and the gap after it, on the terminal.
const GLYPH_CELLS = 2

// Below this many cells the text would break mid-phrase, so the actions go
// under it. The engine's gaps take a few cells more than actionsWidth counts.
const TEXT_MIN = 60

// The cells a row of Buttons takes on the terminal: `[ label ]`, or the bare
// label when plain, one cell between, and a dot and a cell more between two plain ones.
function actionsWidth(buttons: { label: string; plain?: boolean }[]): number {
  const dots = buttons.filter((b, i) => b.plain && buttons[i - 1]?.plain).length
  return buttons.reduce((w, b) => w + b.label.length + (b.plain ? 0 : 4), 0) + Math.max(0, buttons.length - 1) + 2 * dots
}

// A snooze that ran out while idle has shown the band: keep it up from here.
async function unsnooze($: Dollar) {
  const until = await read($, snoozeUntil)
  if (until && until <= (await $.clock.now())) await update($, snoozeUntil, () => 0)
}

async function snooze($: Dollar) {
  const t = await $.clock.now()
  await update($, snoozeUntil, () => t + SNOOZE_MS)
}

// /reload-plugins loads enabledPlugins, hooks and settings in place, and the
// instruction files with them. MCP servers stay as they started.
async function reloadConfig($: Dollar, ctx: Ctx) {
  if (!ctx.isInteractive) return fillReload($)
  if ((await reloadPlugins($, ctx)) === 'reloaded') await snapshot($, ctx, ['settings', 'instructions'])
}

// Core runs /reload-plugins in a non-interactive (Desktop) session only when
// the person sends it, so a press puts it in the prompt box and Return runs it.
// A draft stays put; a box that refuses the text leaves the typed fallback.
async function fillReload($: Dollar) {
  const draft = (await $.prompt.read()).text.trim()
  if (draft && draft !== '/reload-plugins') {
    $.ui.toast('Send or clear your draft, then press Reload again, or type /reload-plugins.')
    return
  }
  const result = await $.prompt.fill({ text: '/reload-plugins' }).catch(() => ({ isFilled: false }))
  if (result.isFilled) await update($, filled, () => true)
  else await update($, reloadBlocked, () => true)
}

async function snapshotPlugins($: Dollar, ctx: Ctx) {
  const versions = await pluginVersions($, ctx.home, ctx.cwd)
  await update($, plugins, () => versions)
  await update($, updates, () => [])
  await update($, reloadBlocked, () => false)
}

// Core's refusal names a remote connection.
function refused(ran: { text?: string } | undefined): boolean {
  return /remote connection/i.test(String(ran?.text ?? ''))
}

// What /reload-plugins prints once it ran: "Reloaded: 8 plugins · ...". A run
// that queued behind a turn answers something else, and may fail later.
function reloaded(ran: { text?: string } | undefined): boolean {
  return /^\s*Reloaded\b/.test(String(ran?.text ?? '').replace(/\x1b\[[0-9;]*m/g, ''))
}

// Ends an unproven reload at its deadline: the band offers the typed command.
async function reloadExpired($: Dollar) {
  const since = await read($, reloadWaitingSince)
  if (since === null || (await $.clock.now()) - since < RELOAD_MAX_MS) return
  // A run still in flight (queued behind a long turn) answers for itself.
  if ((await read($, pending)) === 'reload') return
  await update($, reloadWaitingSince, () => null)
  await update($, reloadBlocked, () => true)
}

async function reloadPlugins($: Dollar, ctx: Ctx) {
  const started = await $.clock.now()
  await update($, reloadWaitingSince, () => started)
  await update($, pending, () => 'reload')
  try {
    const ran = await $.command.run({ command: 'reload-plugins' })
    if (refused(ran)) {
      await update($, reloadWaitingSince, () => null)
      await update($, reloadBlocked, () => true)
      return 'blocked'
    }
    // Queued behind a turn, or an answer that proves nothing: the deadline
    // set above runs on until a Reloaded answer or a new copy proves it.
    if (!reloaded(ran)) return 'pending'
    await update($, reloadWaitingSince, () => null)
    await snapshotPlugins($, ctx)
    return 'reloaded'
  } catch {
    await update($, reloadWaitingSince, () => null).catch(() => {})
    $.ui.toast('Run /reload-plugins to reload.')
    return 'failed'
  } finally {
    await update($, pending, () => '')
  }
}

// Hide what is showing now. A file is back once its content changes again, a
// plugin once a newer version lands.
async function dismiss($: Dollar) {
  const files = await read($, changes)
  const ups = await read($, updates)
  const seen = await read($, dismissed)
  const next: Dismissed = { files: { ...seen.files }, plugins: { ...seen.plugins } }
  // A blocked reload was for what is dismissed: the next change gets its own try.
  await update($, reloadBlocked, () => false)
  await update($, filled, () => false)
  // The content the band showed, not what is on disk now.
  for (const f of files) next.files[f.path] = f.text
  for (const u of ups) next.plugins[u.id] = u.to
  await update($, dismissed, () => next)
  // Drop only what was dismissed: a check may have found something newer meanwhile.
  await update($, changes, cur => cur.filter(f => !(f.path in next.files && next.files[f.path] === f.text)))
  await update($, updates, cur => cur.filter(u => next.plugins[u.id] !== u.to))
}

async function band($: Dollar, e: AbovePromptEvent, ctx: Ctx) {
  if (e.props.hasSurvey || e.props.view?.agentId) return null
  const files = await read($, changes)
  const updated = await read($, updates)
  const checked = await read($, checkedAt)
  if (!checked) return null
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : null
  // The terminal draws no Svg: there the state is a glyph in a theme colour.
  const scheme = Svg ? await colourScheme($) : 'auto'
  const glyph = (mood: Mood) => (
    <Box alignItems="center" justifyContent="center" flexShrink={0} alignSelf={Svg ? 'center' : 'flex-start'}>
      {Svg ? (
        <Svg source={orbit(mood, scheme)} alt={MOODS[mood].alt} width={26} height={26} />
      ) : (
        <Text color={MOODS[mood].key}>{MOODS[mood].char}</Text>
      )}
    </Box>
  )
  // Text beside the actions while it keeps TEXT_MIN cells, else the actions
  // go under it, so no title breaks mid-phrase.
  const layout = (glyph: RenderChildren, title: string, detail: string, actions: Action[], hint = '') => {
    // Bare labels side by side read as one phrase on the terminal: a dim dot
    // parts them. The other surfaces draw each Button as its own control.
    const buttons = actions.flatMap(({ key, ...a }, i) => [
      ...(e.surface === 'terminal' && a.plain && actions[i - 1]?.plain
        ? [
            <Text key={`dot-${key}`} dimColor>
              ·
            </Text>,
          ]
        : []),
      <Button key={key} {...a} />,
    ])
    const stacked = actions.length > 0 && e.props.bodyColumns - GLYPH_CELLS - 1 - actionsWidth(actions) < TEXT_MIN
    // Stacked, the actions go in the text's own column, so they start where the title does.
    const text = (
      <Box key="text" flexDirection="column" flexGrow={1} flexShrink={1} justifyContent="center">
        {/* The desktop clips a Text that names no wrap. */}
        <Text bold wrap="wrap">
          {title}
        </Text>
        {detail !== '' && (
          <Text dimColor size="footnote" wrap="wrap">
            {detail}
          </Text>
        )}
        {hint !== '' && (
          <Text dimColor size="footnote" wrap="wrap">
            {hint}
          </Text>
        )}
        {stacked && (
          <Box key="actions" alignItems="center" gap={1} flexWrap="wrap" marginTop="sm">
            {buttons}
          </Box>
        )}
      </Box>
    )
    if (!stacked) {
      return (
        <Box key="band" alignItems="center" gap={1}>
          {glyph}
          {text}
          {actions.length > 0 && (
            <Box key="actions" alignItems="center" gap={1} flexShrink={0}>
              {buttons}
            </Box>
          )}
        </Box>
      )
    }
    return (
      <Box key="band" flexDirection="column">
        <Box alignItems="flex-start" gap={1}>
          {/* The glyph stays beside the title and detail, not the actions under them. */}
          <Box alignSelf="flex-start" flexShrink={0}>
            {glyph}
          </Box>
          {text}
        </Box>
      </Box>
    )
  }
  const queued = await read($, pending)
  const blocked = await read($, reloadBlocked)
  const waiting = (await read($, reloadWaitingSince)) !== null
  const isFilled = await read($, filled)
  const hasSettings = files.some(f => f.kind === 'settings')
  const hasMcp = files.some(f => f.kind === 'mcp')
  // A plugin update lands in the cache while sessions run, and this one keeps
  // the version it loaded: new sessions start on the update. So the band names
  // updates only beside a settings change, whose Reload loads both, or while
  // a reload is under way.
  const ups = hasSettings || queued || blocked || waiting || isFilled ? updated : []
  // Nothing to report, or snoozed: draw nothing. A snooze that ran out waits
  // for the turn to end, so the band never appears mid-turn.
  if (files.length === 0 && ups.length === 0) return null
  const until = await read($, snoozeUntil)
  if (!queued && until && (until > (await $.clock.now()) || e.props.isWorking)) return null
  const openChanges = () => void $.ui.open({ id: PANE, title: 'What changed', focus: true, closeOnEscape: true })

  // Instruction files alone: the stale-config hook has the next prompt re-read
  // them, so the notice only says so and goes once that turn ends.
  if (!hasSettings && !hasMcp && ups.length === 0 && !queued && !blocked && !waiting && !isFilled) {
    return layout(glyph('stale'), 'Instructions changed.', instructionLine(files), [
      { key: 'changes', label: 'Changes', onPress: openChanges },
      { key: 'dismiss', label: 'Dismiss', plain: true, onPress: () => void dismiss($) },
    ])
  }

  const isConfig = files.length > 0
  const title = staleTitle(files.length, ups)
  const detail =
    queued === 'reload'
      ? 'Reload queued. It runs when this turn ends.'
      : waiting
        ? 'Reload sent. Waiting for it to finish.'
        : blocked
          ? "The reload didn't run here. Type /reload-plugins to load it."
          : isFilled
            ? 'Press Return to run /reload-plugins.'
            : isConfig
              ? [changeLine(files), ...(ups.length > 0 ? [`Also updated: ${ups.map(updateLine).join(', ')}.`] : [])].join(' ')
              : ups.map(updateLine).join(', ')
  const canReload = (hasSettings || (!isConfig && ups.length > 0)) && !blocked && !queued && !waiting && !isFilled
  const hint = queued ? '' : staleHint(files, { interactive: ctx.isInteractive, reload: canReload })
  const actions: Action[] = [
    ...(isConfig ? [{ key: 'changes', label: 'Changes', onPress: openChanges }] : []),
    ...(canReload ? [{ key: 'reload', label: 'Reload', variant: 'primary' as const, onPress: () => void reloadConfig($, ctx) }] : []),
    { key: 'dismiss', label: 'Dismiss', plain: true, onPress: () => void dismiss($) },
    { key: 'later', label: 'Snooze 30 min', plain: true, onPress: () => void snooze($) },
  ]
  return layout(glyph(isConfig || ups.length === 0 ? 'stale' : 'update'), title, detail, actions, hint)
}

// Each file and what happened to it, as one list.
function changeList(files: Pick<FileChange, 'label' | 'status'>[]): string {
  const parts = files.map(f =>
    f.status === 'added' ? `${f.label} was added` : f.status === 'removed' ? `${f.label} was removed` : `${f.label} changed`,
  )
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '')
}

// The stale band's detail.
export function changeLine(files: Pick<FileChange, 'label' | 'status'>[]): string {
  return `${changeList(files)} after this session started.`
}

// The instruction notice's detail: what changed, and that nothing needs doing.
export function instructionLine(files: Pick<FileChange, 'label' | 'status'>[]): string {
  return `${changeList(files)}. This session re-reads ${files.length > 1 ? 'them' : 'it'} on your next message.`
}

const RELOAD_SAYS = 'Reload loads plugins, hooks and settings.'
const RELOAD_FILLS = 'Reload fills in /reload-plugins; press Return to load plugins, hooks and settings.'
const MCP_SAYS = 'MCP servers load only at start: restart with claude --continue to use them.'

// The band's second line: what fixes each kind of change.
export function staleHint(files: Pick<FileChange, 'kind'>[], o: { interactive: boolean; reload: boolean }): string {
  const parts: string[] = []
  if (o.reload) parts.push(o.interactive ? RELOAD_SAYS : RELOAD_FILLS)
  if (files.some(f => f.kind === 'mcp')) parts.push(MCP_SAYS)
  return parts.join(' ')
}

// The band's headline.
export function staleTitle(changedFiles: number, ups: { id: string }[]): string {
  if (changedFiles > 0) return 'Stale session.'
  if (ups.length === 0) return ''
  return `${ups.length === 1 ? (ups[0]?.id.split('@')[0] ?? 'Plugin') : `${ups.length} plugins`} updated.`
}

// One plugin's change for the band: version numbers when they mean something,
// else the short SHAs. Kept short, because the band wraps.
export function updateLine(u: PluginUpdate): string {
  const name = u.id.split('@')[0] ?? u.id
  const semver = (v?: string) => !!v && !/^[0-9a-f]{7,40}$/i.test(v)
  const shas = `${u.from} to ${u.to}`
  if (!semver(u.fromVersion) || !semver(u.toVersion)) return `${name} ${shas}`
  if (u.fromVersion === u.toVersion) return `${name} ${u.toVersion} (${shas})`
  return `${name} ${u.fromVersion} to ${u.toVersion}`
}

export function watchedFiles(home: string, cwd: string): Watched[] {
  return [
    { path: `${home}/.claude/settings.json`, label: 'settings.json', kind: 'settings' },
    { path: `${cwd}/.claude/settings.json`, label: 'project settings.json', kind: 'settings' },
    { path: `${cwd}/.claude/settings.local.json`, label: 'settings.local.json', kind: 'settings' },
    { path: `${cwd}/.mcp.json`, label: '.mcp.json', kind: 'mcp' },
    { path: `${home}/.claude.json`, label: 'MCP servers in ~/.claude.json', kind: 'mcp' },
    { path: `${home}/.claude/CLAUDE.md`, label: 'global CLAUDE.md', kind: 'instructions' },
    { path: `${home}/.agents/AGENTS.md`, label: 'global AGENTS.md', kind: 'instructions' },
    { path: `${cwd}/CLAUDE.md`, label: 'CLAUDE.md', kind: 'instructions' },
    { path: `${cwd}/.claude/CLAUDE.md`, label: '.claude/CLAUDE.md', kind: 'instructions' },
    { path: `${cwd}/CLAUDE.local.md`, label: 'CLAUDE.local.md', kind: 'instructions' },
    { path: `${cwd}/AGENTS.md`, label: 'AGENTS.md', kind: 'instructions' },
  ]
}

export const register: Register = on => {
  const ctx: Ctx = { home: '', cwd: '', watched: [], mtimes: {}, isChecking: false, isWorking: false, isInteractive: false, timers: [] }

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    const cwd = e.cwd
    ctx.home = home
    ctx.cwd = cwd
    ctx.isInteractive = e.isInteractive === true
    ctx.watched = home ? watchedFiles(home, cwd) : []
    ctx.mtimes = {}
    // The config a session started with stays its baseline across reloads.
    if ((await read($, baseline)) === null) {
      const snap: Baseline = {}
      for (const w of ctx.watched) {
        const now = await content($, ctx, w)
        if (now !== undefined) snap[w.path] = now
      }
      await update($, baseline, () => snap)
    } else if ((await read($, reloadWaitingSince)) !== null || (await read($, filled))) {
      // A reload this band asked for swapped in this copy: it ran.
      await snapshot($, ctx, ['settings', 'instructions'])
    }
    await update($, reloadWaitingSince, () => null)
    await snapshotPlugins($, ctx)
    await update($, snoozeUntil, () => 0)
    await update($, filled, () => false)
    // A load drops queued work: the copy that queued it is gone.
    await update($, pending, () => '')
    await check($, ctx)
    // A reload runs session.start again: stop the last load's timers first.
    for (const t of ctx.timers) t?.cancel?.()
    ctx.timers = [$.clock.every(CHECK_MS, () => void check($, ctx).catch(() => {}))]
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result: SessionCompactResult = await next(e)
    if (!('skip' in result && result.skip !== undefined)) await snapshot($, ctx, ['instructions']).catch(() => {})
    return result
  })

  // A /reload-plugins typed or filled in: what it loaded is the new baseline.
  on('command.run', { command: 'reload-plugins' }, async ($, e, next) => {
    const ran = await next(e)
    await update($, filled, () => false).catch(() => {})
    if (reloaded(ran)) {
      await snapshotPlugins($, ctx).catch(() => {})
      await update($, reloadWaitingSince, () => null).catch(() => {})
      await snapshot($, ctx, ['settings', 'instructions']).catch(() => {})
    }
    return ran
  })

  // turn.complete ends every turn, an interrupted or failed one too.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) ctx.isWorking = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      ctx.isWorking = false
      await retireTold($, ctx).catch(() => {})
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    await unsnooze($).catch(() => {})
    // Something else was sent in place of the filled /reload-plugins.
    if (e.origin.kind === 'composer' && !/^\s*\/reload-plugins\b/.test(e.text)) await update($, filled, () => false).catch(() => {})
    await check($, ctx).catch(() => {})
    await noteTold($, ctx, e.text).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods draw in this band too: stack ours above theirs.
    const below = await next(e)
    const mine = await band($, e, ctx)
    if (!mine) return below
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" gap={1}>
        {mine}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const files = await read($, changes)
    // The engine draws no title over a lone pane, so the body carries it.
    const heading = (
      <Text key="title" wrap="wrap">
        <Text bold>What changed since this session started</Text>
        <Text dimColor> · Esc closes</Text>
      </Text>
    )
    if (files.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          {heading}
          <Text dimColor wrap="wrap">
            No config has changed since this session started.
          </Text>
        </Box>
      )
    }
    const pad = (x?: number) => (x === undefined ? '    ' : String(x).padStart(4, ' '))
    const home = ctx.home ? `${ctx.home}/` : ''
    return (
      <Box flexDirection="column" gap={1}>
        {heading}
        {files.map(f => (
          <Box key={f.path} flexDirection="column">
            <Text bold wrap="wrap">
              {f.label}
              {f.status === 'added' ? ' (new)' : f.status === 'removed' ? ' (deleted)' : ''}{' '}
              <Text color="diffAdded">+{f.added}</Text> <Text color="diffRemoved">-{f.removed}</Text>
            </Text>
            {/* A path has no spaces to wrap at: cut its middle, keep the root and the file. */}
            <Text dimColor size="caption" wrap="truncate-middle">
              {home && f.path.startsWith(home) ? `~/${f.path.slice(home.length)}` : f.path}
              {f.kind === 'settings' ? ' · enabledPlugins only' : f.kind === 'mcp' ? ' · MCP servers only' : ''}
            </Text>
            <Box key="cols">
              <Box width="50%" flexShrink={1} minWidth={0}>
                <Text dimColor bold>Before</Text>
              </Box>
              <Box width="50%" flexShrink={1} minWidth={0}>
                <Text dimColor bold>Now</Text>
              </Box>
            </Box>
            {pairRows(f.lines).map((r, k) =>
              r.kind === 'gap' ? (
                <Box key={`gap-${k}`}>
                  <Text dimColor mono wrap="wrap">
                    {'     ⋯ '}
                    {r.text}
                  </Text>
                </Box>
              ) : (
                <Box key={`line-${k}`}>
                  {[r.left, r.right].map((l, side) => {
                    const n = side === 0 ? l?.a : l?.b
                    const color = l?.kind === 'add' ? 'diffAdded' : l?.kind === 'del' ? 'diffRemoved' : undefined
                    const sign = l?.kind === 'add' ? '+' : l?.kind === 'del' ? '-' : ' '
                    return (
                      // Each side keeps its gutter; a changed line wraps in full, an unchanged one stays on one line.
                      <Box key={side === 0 ? 'old' : 'new'} width="50%" flexShrink={1} minWidth={0}>
                        <Box flexShrink={0}>
                          <Text mono color={color} dimColor={l?.kind === 'same'}>
                            {l ? `${pad(n)} ${sign} ` : '       '}
                          </Text>
                        </Box>
                        {l && r.words ? (
                          // A paired line: a faint tint across the column, its changed words on a stronger one in the same hue.
                          <Box flexGrow={1} flexShrink={1} minWidth={0} backgroundColor={side === 0 ? 'diffRemovedDimmed' : 'diffAddedDimmed'}>
                            <Text mono wrap="wrap" backgroundColor={side === 0 ? 'diffRemovedDimmed' : 'diffAddedDimmed'}>
                              {r.words[side === 0 ? 'left' : 'right'].map((s, i) =>
                                s.changed ? (
                                  <Text key={String(i)} backgroundColor={side === 0 ? 'diffRemovedWord' : 'diffAddedWord'}>
                                    {s.text}
                                  </Text>
                                ) : (
                                  s.text
                                ),
                              )}
                            </Text>
                          </Box>
                        ) : l ? (
                          <Text mono wrap={l.kind === 'same' ? 'truncate-end' : 'wrap'} color={color} dimColor={l.kind === 'same'}>
                            {l.text}
                          </Text>
                        ) : null}
                      </Box>
                    )
                  })}
                </Box>
              ),
            )}
          </Box>
        ))}
      </Box>
    )
  })
}

type Mood = 'stale' | 'update'

// Per state: the terminal's glyph and theme key, and the desktop mark's
// colour as a light and dark pair, each 3:1 or better on its background.
const MOODS: Record<Mood, { char: string; key: ThemeKey; light: string; dark: string; alt: string }> = {
  stale: { char: '●', key: 'warning', light: '#B4532F', dark: '#D97757', alt: 'Stale session' },
  update: { char: '↑', key: 'success', light: '#8A6417', dark: '#C69A4C', alt: 'Plugin updated' },
}

// The person's theme setting; 'auto' leaves it to the surface's colour scheme.
async function colourScheme($: Dollar): Promise<'light' | 'dark' | 'auto'> {
  const rows = await $.config.list().catch(() => [])
  const theme = String(rows.find(r => r.key === 'theme')?.value ?? '')
  return /light/.test(theme) ? 'light' : /dark/.test(theme) ? 'dark' : 'auto'
}

// The desktop's state mark: a dot in a faint ring. It never moves: a passive
// status does not.
function orbit(mood: Mood, scheme: 'light' | 'dark' | 'auto'): string {
  const m = MOODS[mood]
  // Class names carry the state, so the style never reaches another mark or the page around it.
  const c = (n: string) => `stale-config-${mood}-${n}`
  const paint = (col: string) => `.${c('f')}{fill:${col}}.${c('s')}{stroke:${col}}`
  const colours =
    scheme === 'auto' ? `${paint(m.dark)}@media (prefers-color-scheme: light){${paint(m.light)}}` : paint(scheme === 'light' ? m.light : m.dark)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
<style>${colours}</style>
<circle class="${c('s')}" cx="13" cy="13" r="9" fill="none" stroke-opacity="0.3" stroke-width="1.5"/>
<circle class="${c('f')}" cx="13" cy="13" r="3.2"/>
</svg>`
}
