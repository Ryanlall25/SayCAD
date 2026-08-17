import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  GRID_CYCLE,
  gridSpecFor,
  isGridMode,
  loadGridMode,
  nextGridMode,
  saveGridMode,
  type GridMode
} from './grid'

/**
 * Flag 66ce81b5, verbatim: "the grid should be fixed at the background with an
 * option to overlay or remove completely." These tests hold the module to that
 * sentence — three states, and a cycle that can actually reach "removed".
 */

describe('grid mode cycle', () => {
  it('offers exactly the three states the flag asks for', () => {
    expect([...GRID_CYCLE]).toEqual(['background', 'overlay', 'off'])
  })

  it('starts at background — the flag makes that the resting state', () => {
    expect(GRID_CYCLE[0]).toBe('background')
  })

  it('cycles background -> overlay -> off -> background', () => {
    expect(nextGridMode('background')).toBe('overlay')
    expect(nextGridMode('overlay')).toBe('off')
    expect(nextGridMode('off')).toBe('background')
  })

  it('reaches "removed completely" from every state within one cycle', () => {
    // The explicit ask is that the grid can be got rid of. A cycle that only
    // alternated between two visible states would satisfy "toggle" and fail
    // the actual request.
    for (const start of GRID_CYCLE) {
      let m: GridMode = start
      const seen: GridMode[] = []
      for (let i = 0; i < GRID_CYCLE.length; i++) {
        m = nextGridMode(m)
        seen.push(m)
      }
      expect(seen, start).toContain('off')
    }
  })

  it('returns to where it started after a full cycle', () => {
    for (const start of GRID_CYCLE) {
      let m: GridMode = start
      for (let i = 0; i < GRID_CYCLE.length; i++) m = nextGridMode(m)
      expect(m).toBe(start)
    }
  })
})

describe('grid sizing', () => {
  it('keeps a real, fixed millimetre cell rather than a constant division count', () => {
    // A cell that silently rescales with the model makes the grid look like a
    // ruler while measuring nothing. size/divisions must equal cellMm exactly.
    for (const r of [5, 12, 20, 45, 80, 150, 400]) {
      const { size, divisions, cellMm } = gridSpecFor(r)
      expect(size / divisions, `r=${r}`).toBeCloseTo(cellMm, 6)
    }
  })

  it('steps the cell up as the case grows, so line count stays bounded', () => {
    const small = gridSpecFor(8) // single unit
    const arch = gridSpecFor(60) // full arch
    expect(small.cellMm).toBeLessThanOrEqual(arch.cellMm)
    for (const r of [5, 20, 60, 150, 400]) {
      expect(gridSpecFor(r).divisions, `r=${r}`).toBeLessThanOrEqual(400)
    }
  })

  it('always extends past the model so it reads as a floor, not a mat', () => {
    for (const r of [5, 20, 60, 150]) {
      expect(gridSpecFor(r).size).toBeGreaterThan(r * 2)
    }
  })

  it('survives a garbage radius instead of producing NaN geometry', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const spec = gridSpecFor(bad as number)
      expect(Number.isFinite(spec.size), String(bad)).toBe(true)
      expect(Number.isFinite(spec.divisions), String(bad)).toBe(true)
      expect(spec.divisions).toBeGreaterThan(0)
    }
  })
})

describe('grid preference persistence', () => {
  // The suite runs in node, with no DOM. A minimal in-memory stub is the right
  // double here anyway: what is under test is this module's own guard
  // behaviour on a hostile store, not the browser's Storage implementation.
  const installStorage = (impl: Partial<Storage>): void => {
    ;(globalThis as { localStorage?: unknown }).localStorage = impl as Storage
  }

  beforeEach(() => {
    const map = new Map<string, string>()
    installStorage({
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear()
    })
    vi.restoreAllMocks()
  })

  it('defaults to background on a fresh install', () => {
    expect(loadGridMode()).toBe('background')
  })

  it('round-trips a saved choice', () => {
    saveGridMode('overlay')
    expect(loadGridMode()).toBe('overlay')
    saveGridMode('off')
    expect(loadGridMode()).toBe('off')
  })

  it('falls back to the default on a corrupt value instead of throwing', () => {
    localStorage.setItem('saycad.grid', 'sideways')
    expect(loadGridMode()).toBe('background')
  })

  it('never lets an unavailable localStorage stop the editor opening', () => {
    // A thrown getItem (private mode, denied storage) must not take the whole
    // editor down over a cosmetic preference.
    installStorage({
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      }
    })
    expect(() => loadGridMode()).not.toThrow()
    expect(loadGridMode()).toBe('background')
    expect(() => saveGridMode('overlay')).not.toThrow()
  })

  it('survives localStorage being absent entirely', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    expect(() => loadGridMode()).not.toThrow()
    expect(loadGridMode()).toBe('background')
    expect(() => saveGridMode('off')).not.toThrow()
  })

  it('guards the type at the boundary', () => {
    expect(isGridMode('background')).toBe(true)
    expect(isGridMode('overlay')).toBe(true)
    expect(isGridMode('off')).toBe(true)
    expect(isGridMode('')).toBe(false)
    expect(isGridMode(null)).toBe(false)
    expect(isGridMode('Background')).toBe(false)
  })
})
