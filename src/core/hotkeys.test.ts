/**
 * Hotkey tests. Every case dispatches a REAL KeyboardEvent-shaped object
 * through the resolver and asserts the resulting ACTION — not that a handler
 * exists. The reserved-combo tests are the load-bearing ones: they assert a
 * refusal that must hold for every modifier permutation, so a future binding
 * cannot quietly claim Ctrl+W.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveHotkey,
  isBrowserReserved,
  BROWSER_RESERVED,
  VIEW_SNAP_KEYS,
  GROUP_KEYS,
  VIEW_SNAP_DIRECTIONS,
  HOTKEY_HELP_ROWS,
  WIRED_ACTION_KINDS,
  UNWIRED_HELP_MARKERS,
  helpKeyTokens,
  isWired,
  type HotkeyAction
} from './hotkeys'
import { navHelpRows } from './viewerRig'

/** Event factory. NOTE: this vitest project runs in the `node` environment
 *  (no jsdom/happy-dom dependency), so a real `KeyboardEvent` cannot be
 *  constructed here. These tests therefore exercise the resolver over the
 *  exact property names the browser supplies, and the "does it actually fire
 *  in the running app" half of the requirement is covered separately by
 *  dispatching REAL KeyboardEvents into the live Electron app over CDP
 *  (see the run report). Adding a DOM env just for this would have meant a
 *  new dependency + lockfile change inside a sandbox run. */
function ev(
  code: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}
): { code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean } {
  return {
    code,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta
  }
}
function press(
  code: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}
): HotkeyAction | null {
  return resolveHotkey(ev(code, mods), { toolModeActive: false })
}
function pressInTool(code: string): HotkeyAction | null {
  return resolveHotkey(ev(code), { toolModeActive: true })
}

describe('hotkeys — category 1: view snaps on the number row', () => {
  it('maps 1-5 to occlusal/facial/left/right/fit when no tool is active', () => {
    expect(press('Digit1')).toEqual({ kind: 'view', view: 'occlusal' })
    expect(press('Digit2')).toEqual({ kind: 'view', view: 'facial' })
    expect(press('Digit3')).toEqual({ kind: 'view', view: 'left' })
    expect(press('Digit4')).toEqual({ kind: 'view', view: 'right' })
    expect(press('Digit5')).toEqual({ kind: 'view', view: 'fit' })
  })

  it('uses the NUMBER ROW, not the numpad (target hardware has none)', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(press(`Numpad${n}`)).toBeNull()
    }
    // Every DIGIT snap is number-row; KeyF is the one non-digit alias.
    expect(
      Object.keys(VIEW_SNAP_KEYS).every((k) => k.startsWith('Digit') || k === 'KeyF')
    ).toBe(true)
    expect(Object.keys(VIEW_SNAP_KEYS).some((k) => k.startsWith('Numpad'))).toBe(false)
  })

  it('gives every non-fit snap a real camera direction', () => {
    for (const view of ['occlusal', 'facial', 'left', 'right'] as const) {
      const d = VIEW_SNAP_DIRECTIONS[view]
      expect(d).toBeDefined()
      expect(Math.hypot(d[0], d[1], d[2])).toBeGreaterThan(0.5)
    }
    // left and right must be genuinely opposite lateral views, not aliases.
    expect(VIEW_SNAP_DIRECTIONS.left[0]).toBeLessThan(0)
    expect(VIEW_SNAP_DIRECTIONS.right[0]).toBeGreaterThan(0)
  })

  it('binds F to fit as well as 5 (owner-approved; spec assumed F existed)', () => {
    expect(press('KeyF')).toEqual({ kind: 'view', view: 'fit' })
    expect(press('Digit5')).toEqual({ kind: 'view', view: 'fit' })
    // F must NOT be hijacked while a tool owns the number row.
    expect(pressInTool('KeyF')).toEqual({ kind: 'view', view: 'fit' })
  })

  it('ignores digits 6-9 for view snaps', () => {
    for (const n of [6, 7, 8, 9]) expect(press(`Digit${n}`)).toBeNull()
  })
})

describe('hotkeys — category 2: scene-group show/hide', () => {
  it('maps U/L/B/O to upper/lower/bite/other', () => {
    expect(press('KeyU')).toEqual({ kind: 'group', group: 'upper' })
    expect(press('KeyL')).toEqual({ kind: 'group', group: 'lower' })
    expect(press('KeyB')).toEqual({ kind: 'group', group: 'bite' })
    expect(press('KeyO')).toEqual({ kind: 'group', group: 'other' })
  })

  it('is extensible by table only — every entry resolves without extra code', () => {
    for (const [code, group] of Object.entries(GROUP_KEYS)) {
      expect(press(code)).toEqual({ kind: 'group', group })
    }
  })

  it('does not fire group toggles when a modifier is held', () => {
    expect(press('KeyU', { ctrl: true })).toBeNull()
    expect(press('KeyL', { shift: true })).toBeNull()
    expect(press('KeyB', { alt: true })).toBeNull()
  })
})

describe('hotkeys — categories 3, 4, 6: undo/redo, save, measure', () => {
  it('binds Ctrl+Z undo and Ctrl+Shift+Z redo (web/3Shape convention)', () => {
    expect(press('KeyZ', { ctrl: true })).toEqual({ kind: 'undo' })
    expect(press('KeyZ', { ctrl: true, shift: true })).toEqual({ kind: 'redo' })
  })

  it('does NOT bind exocad Ctrl+Y for redo', () => {
    expect(press('KeyY', { ctrl: true })).toBeNull()
  })

  it('binds Ctrl+S for save', () => {
    expect(press('KeyS', { ctrl: true })).toEqual({ kind: 'save' })
  })

  it('binds Ctrl+M for measure and NOT exocad Ctrl+R (which reloads the tab)', () => {
    expect(press('KeyM', { ctrl: true })).toEqual({ kind: 'measure' })
    expect(press('KeyR', { ctrl: true })).toBeNull()
  })

  it('accepts Cmd as well as Ctrl (metaKey) for the same combos', () => {
    expect(press('KeyZ', { meta: true })).toEqual({ kind: 'undo' })
    expect(press('KeyS', { meta: true })).toEqual({ kind: 'save' })
  })
})

describe('hotkeys — category 5: tool-mode switching', () => {
  it('gives the number row to the TOOL while a tool mode is active', () => {
    for (let n = 1; n <= 7; n++) {
      expect(pressInTool(`Digit${n}`)).toEqual({ kind: 'toolMode', index: n })
    }
  })

  it('resolves the SAME key differently by mode — the modal rule', () => {
    // This is the assertion that proves categories 1 and 5 coexist rather
    // than one silently shadowing the other.
    expect(press('Digit3')).toEqual({ kind: 'view', view: 'left' })
    expect(pressInTool('Digit3')).toEqual({ kind: 'toolMode', index: 3 })
  })

  it('stops at 7 — digits 8/9 are unbound in tool mode', () => {
    expect(pressInTool('Digit8')).toBeNull()
    expect(pressInTool('Digit9')).toBeNull()
  })
})

describe('hotkeys — category 7: browser-reserved combos are refused BY CONSTRUCTION', () => {
  it('never resolves an action for any reserved combo, under any modifier mix', () => {
    for (const code of BROWSER_RESERVED) {
      for (const mods of [
        { ctrl: true },
        { meta: true },
        { ctrl: true, shift: true },
        { meta: true, shift: true },
        { ctrl: true, alt: true }
      ]) {
        expect(press(code, mods)).toBeNull()
      }
    }
  })

  it('refuses Ctrl+W specifically — the highest-risk combo (closes the tab)', () => {
    expect(press('KeyW', { ctrl: true })).toBeNull()
    expect(press('KeyW', { meta: true })).toBeNull()
    expect(isBrowserReserved(ev('KeyW', { ctrl: true }))).toBe(true)
  })

  it('lists every combo the dispatch named', () => {
    for (const code of ['KeyN', 'KeyD', 'KeyW', 'KeyQ', 'KeyP', 'Tab']) {
      expect(BROWSER_RESERVED).toContain(code)
    }
  })

  it('does not over-reserve: the same letters are free WITHOUT a modifier', () => {
    // Plain D/N/P/Q/W must stay available for future single-letter bindings;
    // only the Ctrl/Cmd combos are unreachable in a tab.
    expect(isBrowserReserved(ev('KeyW'))).toBe(false)
    expect(isBrowserReserved(ev('KeyD'))).toBe(false)
  })
})

describe('hotkeys — non-interference with the existing layout', () => {
  it('does not claim Escape (cancel active tool stays with the editor)', () => {
    expect(press('Escape')).toBeNull()
    expect(pressInTool('Escape')).toBeNull()
  })

  it('does not claim Delete/Backspace (deletion stays with the editor)', () => {
    expect(press('Delete')).toBeNull()
    expect(press('Backspace')).toBeNull()
  })

  it('does not claim PageUp/PageDown (step-rotate stays with the viewer rig)', () => {
    expect(press('PageUp')).toBeNull()
    expect(press('PageDown')).toBeNull()
  })
})

/**
 * The help panel is the ONLY thing that tells a user a key exists. If it names
 * a key the editor does not implement, the user presses it, nothing happens,
 * and no error is reported — indistinguishable from a broken app. These tests
 * make that state impossible to commit.
 */
describe('hotkeys — the help panel cannot advertise an unwired key', () => {
  /** The check under test, applied to an arbitrary row set so the mutation
   *  guard below can run the REAL logic against a deliberately bad panel. */
  function unwiredAdvertised(rows: ReadonlyArray<readonly [string, string]>): string[] {
    const bad: string[] = []
    for (const [kind, marker] of Object.entries(UNWIRED_HELP_MARKERS)) {
      if (WIRED_ACTION_KINDS.includes(kind as HotkeyAction['kind'])) continue
      for (const [label, keyColumn] of rows) {
        if (label.includes(marker.label)) bad.push(`${kind}:label`)
        for (const tok of helpKeyTokens(keyColumn)) {
          if (marker.keys.includes(tok)) bad.push(`${kind}:${tok}`)
        }
      }
    }
    return bad
  }

  it('names no binding whose action kind is unwired', () => {
    expect(unwiredAdvertised(HOTKEY_HELP_ROWS)).toEqual([])
  })

  it('does not false-positive on Ctrl+Shift+Z, which CONTAINS "Ctrl+S"', () => {
    // The substring trap this check was rewritten to avoid.
    expect(unwiredAdvertised([['Undo / Redo', 'Ctrl+Z · Ctrl+Shift+Z']])).toEqual([])
  })

  it('BITES — re-adding the Ctrl+M measure row while unwired is rejected', () => {
    // Mutation guard: the real logic must reject the exact row that was
    // removed, rather than passing because it never looks at anything.
    expect(WIRED_ACTION_KINDS).not.toContain('measure')
    expect(unwiredAdvertised([...HOTKEY_HELP_ROWS, ['Measure', 'Ctrl+M']])).toContain(
      'measure:Ctrl+M'
    )
    expect(unwiredAdvertised([['Show/hide group: upper', 'U · L · B · O']]).length).toBeGreaterThan(
      0
    )
  })

  it('still RESOLVES the unwired combos — they are gated, not deleted', () => {
    // The research stays intact for when Wave 4 lands; only the advertising
    // and the dispatch are gated.
    const save = press('KeyS', { ctrl: true })
    const measure = press('KeyM', { ctrl: true })
    expect(save).toEqual({ kind: 'save' })
    expect(measure).toEqual({ kind: 'measure' })
    expect(isWired(save!)).toBe(false)
    expect(isWired(measure!)).toBe(false)
    // Group keys resolve too, but must stay unwired while no arch role exists.
    expect(isWired(press('KeyU')!)).toBe(false)
    expect(isWired(pressInTool('Digit3')!)).toBe(false)
  })

  it('marks every view/undo/redo action as wired', () => {
    const snap = press('Digit1')
    const undo = press('KeyZ', { ctrl: true })
    const redo = press('KeyZ', { ctrl: true, shift: true })
    for (const a of [snap, undo, redo]) expect(isWired(a!)).toBe(true)
  })
})

describe('nav help rows follow what the host actually bound', () => {
  it('names Ctrl+1–8 only when the host kept those aliases', () => {
    const withAliases = navHelpRows(true).map((r) => r[1]).join(' | ')
    const without = navHelpRows(false).map((r) => r[1]).join(' | ')
    expect(withAliases).toContain('Ctrl+1–8')
    expect(withAliases).toContain('Ctrl+0')
    // SayCADEditor turns them off — the panel must stop advertising them,
    // or the user presses Ctrl+3, gets nothing, and blames themselves.
    expect(without).not.toContain('Ctrl+1–8')
    expect(without).not.toContain('Ctrl+0')
  })

  it('keeps the numpad presets in BOTH modes — only the alias is scoped', () => {
    for (const rows of [navHelpRows(true), navHelpRows(false)]) {
      const text = rows.map((r) => `${r[0]} ${r[1]}`).join(' | ')
      expect(text).toContain('Numpad 1–8')
      expect(text).toContain('Numpad 5')
      expect(text).toContain('Preset views')
    }
  })

  it('changes nothing else between the two variants', () => {
    const a = navHelpRows(true)
    const b = navHelpRows(false)
    expect(a.length).toBe(b.length)
    const differing = a.filter((row, i) => row[1] !== b[i][1]).map((row) => row[0])
    expect(differing).toEqual(['Preset views', 'Fit all'])
  })

  it('does not double-list the grid — it lives in the nav rows, not the hotkey rows', () => {
    // Both tables render into the SAME help panel; a duplicated row is the
    // visible symptom of two sources of truth.
    expect(navHelpRows(false).some((r) => r[0].startsWith('Grid'))).toBe(true)
    expect(HOTKEY_HELP_ROWS.some((r) => r[0].startsWith('Grid'))).toBe(false)
  })
})
