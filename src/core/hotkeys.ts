/**
 * SayCAD hotkey resolution — pure, testable mapping from a keyboard event
 * to an intended action. Kept separate from the editor so every binding can
 * be tested by dispatching a REAL event object rather than asserting that a
 * handler exists.
 *
 * Design notes that are load-bearing (see the C1 hotkey dispatch):
 *
 * - NUMBER ROW, not numpad: the target hardware has no numpad, so view snaps
 *   are `Digit1..Digit5`. (`viewerRig` retains its own legacy Numpad/Digit
 *   preset handling; see `resolveHotkey`'s modal rule and the run report for
 *   the collision this creates.)
 * - UNDO/REDO are Ctrl+Z / Ctrl+Shift+Z — the web + 3Shape convention.
 *   exocad's Ctrl+Y is deliberately NOT bound: in a browser tab Ctrl+Y is
 *   history in some browsers and nothing in others.
 * - MEASURE is Ctrl+M, deliberately NOT exocad's Ctrl+R (reloads the tab and
 *   destroys all scene state).
 * - BROWSER-RESERVED combos are refused BY CONSTRUCTION (see
 *   `BROWSER_RESERVED` / `isBrowserReserved`): Ctrl+N/D/W/Q/P and Ctrl+Tab
 *   cannot be captured in a tab, so binding them would silently do something
 *   else — Ctrl+W closing the tab being the highest-risk case. Any future
 *   binding must pass through `resolveHotkey`, which returns null for these
 *   before consulting any other rule.
 */

export type ViewSnap = 'occlusal' | 'facial' | 'left' | 'right' | 'fit'
export type SceneGroup = 'upper' | 'lower' | 'bite' | 'other'

export type HotkeyAction =
  | { kind: 'view'; view: ViewSnap }
  | { kind: 'group'; group: SceneGroup }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'save' }
  | { kind: 'toolMode'; index: number }
  | { kind: 'measure' }

/** Combos that must NEVER be bound — unreachable and/or destructive in a tab. */
export const BROWSER_RESERVED: ReadonlyArray<string> = [
  'KeyN', // new window
  'KeyD', // bookmark
  'KeyW', // CLOSES THE TAB — highest risk
  'KeyQ', // quit
  'KeyP', // print
  'Tab' // tab switching
]

/** Category 1 — view snaps on the number row (no numpad on target hardware). */
export const VIEW_SNAP_KEYS: Readonly<Record<string, ViewSnap>> = {
  Digit1: 'occlusal',
  Digit2: 'facial',
  Digit3: 'left',
  Digit4: 'right',
  Digit5: 'fit',
  // F = fit as well (owner-approved addition: the layout spec assumed F
  // already existed; it did not — fit was 0/Numpad5 in viewerRig only).
  KeyF: 'fit'
}

/** Category 2 — scene-group show/hide. Extensible: add a letter here and a
 *  matching role in the editor's group map; nothing else needs to change. */
export const GROUP_KEYS: Readonly<Record<string, SceneGroup>> = {
  KeyU: 'upper',
  KeyL: 'lower',
  KeyB: 'bite',
  KeyO: 'other'
}

/** Category 5 — tool-mode switching inside a step. */
export const TOOL_MODE_MAX = 7

export interface HotkeyEventLike {
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export interface HotkeyContext {
  /** True while a tool owns the step (sculpt/margin/align/…). Decides who
   *  owns the number row — see the modal rule in `resolveHotkey`. */
  toolModeActive: boolean
}

/** True for combos this app refuses to bind under any circumstance. */
export function isBrowserReserved(e: HotkeyEventLike): boolean {
  if (!(e.ctrlKey || e.metaKey)) return false
  return BROWSER_RESERVED.includes(e.code)
}

/**
 * Resolve an event to an action, or null if it is not a SayCAD hotkey.
 *
 * MODAL RULE for the number row: categories 1 (view snaps 1–5) and 5
 * (tool modes 1–7) both claim the number row — that overlap is inherent to
 * the specification, not a bug in it. Resolution: while a tool mode is
 * active the tool owns 1–7; otherwise the viewer owns 1–5. This matches the
 * pre-existing sculpt brush behaviour (1/2/3 switched brushes only while
 * sculpting), so it is the convention already established in the app.
 */
export function resolveHotkey(e: HotkeyEventLike, ctx: HotkeyContext): HotkeyAction | null {
  // Reserved combos are refused before anything else is considered.
  if (isBrowserReserved(e)) return null

  if (e.ctrlKey || e.metaKey) {
    if (e.altKey) return null
    switch (e.code) {
      case 'KeyZ':
        return e.shiftKey ? { kind: 'redo' } : { kind: 'undo' }
      case 'KeyS':
        return e.shiftKey ? null : { kind: 'save' }
      case 'KeyM':
        return e.shiftKey ? null : { kind: 'measure' }
      default:
        return null
    }
  }

  if (e.shiftKey || e.altKey) return null

  // KeyF (fit) is checked BEFORE the tool-mode digit rule so a tool owning
  // the number row never swallows it.
  if (e.code === 'KeyF') return { kind: 'view', view: 'fit' }

  const digit = /^Digit([1-9])$/.exec(e.code)
  if (digit) {
    const n = Number(digit[1])
    if (ctx.toolModeActive) {
      return n <= TOOL_MODE_MAX ? { kind: 'toolMode', index: n } : null
    }
    const view = VIEW_SNAP_KEYS[e.code]
    return view ? { kind: 'view', view } : null
  }

  const group = GROUP_KEYS[e.code]
  if (group) return { kind: 'group', group }

  return null
}

/** Camera directions for the view snaps. `fit` is handled by the rig's own
 *  fit routine and therefore carries no direction.
 *
 *  CONVENTION — STATE IT, DO NOT TRUST IT SILENTLY:
 *  `left` places the camera on the −X side of the scan frame and looks toward
 *  +X; `right` is the mirror. This is a SCAN-FRAME / VIEWER-relative
 *  convention, NOT a patient-laterality one. Nothing in a raw PLY pair
 *  encodes which side of the patient +X is, so this mapping CANNOT be
 *  asserted to mean "patient's left" — that requires case metadata this
 *  pipeline does not read.
 *
 *  Related conflict worth knowing: the vectors reused here are the rig's
 *  `lingual` (−X) and `buccal` (+X) presets, which are ANATOMICAL SURFACE
 *  names (tongue side / cheek side), not lateral positions. For an upper
 *  arch, buccal is toward the cheek on BOTH sides of the mouth, so
 *  "left/right" and "buccal/lingual" are different axes of meaning that
 *  happen to share these vectors on this case. Confirm against a known case
 *  before relying on the labels clinically. */
export const VIEW_SNAP_DIRECTIONS: Readonly<Record<Exclude<ViewSnap, 'fit'>, [number, number, number]>> = {
  occlusal: [0, 1, 0.03],
  facial: [0, 0.1, 1],
  left: [-1, 0.15, 0.2],
  right: [1, 0.15, 0.2]
}

/**
 * Action kinds the editor actually IMPLEMENTS on this tree.
 *
 * `resolveHotkey` deliberately still RESOLVES save / measure / toolMode /
 * group — that mapping is researched and tested, and the features it targets
 * exist on the Wave 4 design branch. Here they have no implementation:
 *
 *   save     — no save routine in SayCADEditor
 *   measure  — no measure tool
 *   toolMode — no tool modes (sculpt / margin / align are Wave 4)
 *   group    — scan meshes carry only `sourceName?: string` and no arch role,
 *              so upper/lower/bite could only be GUESSED from a filename
 *
 * Two rules follow, both load-bearing:
 *   1. The editor must NOT preventDefault for an unwired kind. Swallowing
 *      Ctrl+S and then doing nothing is worse than leaving it unbound — it
 *      breaks a key the user expects to work, silently.
 *   2. The help panel must not advertise an unwired key. A row promising
 *      "Measure — Ctrl+M" beside a key that does nothing is the dead-route
 *      failure mode in miniature.
 *
 * `hotkeys.test.ts` enforces rule 2 against this list, so advertising a
 * binding without wiring it fails the suite.
 */
export const WIRED_ACTION_KINDS: ReadonlyArray<HotkeyAction['kind']> = ['view', 'undo', 'redo']

/** True when the editor has a real implementation for this action. */
export function isWired(action: HotkeyAction): boolean {
  return WIRED_ACTION_KINDS.includes(action.kind)
}

/**
 * What the help panel must NOT show while the matching kind is unwired.
 *
 * `keys` are matched as EXACT tokens, never as substrings: `Ctrl+S` is a
 * prefix of `Ctrl+Shift+Z`, so a substring check would condemn the perfectly
 * valid undo/redo row. Key columns are therefore split on `·` and compared
 * token-by-token. Labels stay substring matches — they are prose.
 */
export const UNWIRED_HELP_MARKERS: Readonly<
  Record<string, { readonly keys: ReadonlyArray<string>; readonly label: string }>
> = {
  save: { keys: ['Ctrl+S'], label: 'Save design' },
  measure: { keys: ['Ctrl+M'], label: 'Measure' },
  toolMode: { keys: ['1 – 7'], label: 'Tool mode' },
  group: { keys: ['U', 'L', 'B', 'O'], label: 'Show/hide group' }
}

/** Split a help row's key column into comparable tokens. */
export function helpKeyTokens(keyColumn: string): string[] {
  return keyColumn
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Rows for the on-screen help panel — WIRED KEYS ONLY.
 *  Esc / Delete are owned by the editor's own handler rather than by
 *  `resolveHotkey`, but they are real, so they are listed. The GRID row is
 *  deliberately absent: `NAV_HELP_ROWS` already carries it and both tables
 *  render into the same panel. */
export const HOTKEY_HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['View: occlusal / facial / left / right', '1 · 2 · 3 · 4'],
  ['Fit view', '5 · F'],
  ['Undo / Redo', 'Ctrl+Z · Ctrl+Shift+Z'],
  ['Cancel / clear selection', 'Esc'],
  ['Delete selected', 'Del']
]
