export type DiffLine = { kind: 'same' | 'add' | 'del' | 'gap'; text: string; a?: number; b?: number }
// A word diff's run of tokens, changed or not, on one side of a paired row.
export type WordSeg = { text: string; changed: boolean }
// One row of the side-by-side view: the old line on the left, the new one on the right.
export type DiffRow =
  | { kind: 'row'; left?: DiffLine; right?: DiffLine; words?: { left: WordSeg[]; right: WordSeg[] } }
  | { kind: 'gap'; text: string }
// What a watched file holds that a running session cannot pick up by itself.
export type Kind = 'settings' | 'mcp' | 'instructions'
export type FileChange = {
  path: string
  label: string
  kind: Kind
  status: 'added' | 'removed' | 'changed'
  added: number
  removed: number
  lines: DiffLine[]
  text: string | null
}
// from and to are short commit SHAs (the identity); the versions are for display.
export type PluginUpdate = { id: string; from: string; to: string; fromVersion?: string; toVersion?: string }
export type PluginVersion = { sha: string; version: string }
export type Baseline = Record<string, string | null>
// Instruction files a prompt was sent with; `skip` counts a turn already running then.
export type Told = { files: Baseline; skip: number }
export type Dismissed = { files: Record<string, string | null>; plugins: Record<string, string> }

declare module 'claude-code' {
  interface PluginState {
    'stale-config': {
      baseline: Baseline | null
      plugins: Record<string, PluginVersion> | null
      changes: FileChange[]
      updates: PluginUpdate[]
      snoozeUntil: number
      dismissed: Dismissed
      checkedAt: number
      pending: '' | 'reload'
      reloadBlocked: boolean
      reloadWaitingSince: number | null
      filled: boolean
      told: Told
    }
  }
}
