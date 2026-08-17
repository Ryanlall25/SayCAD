import * as THREE from 'three'

/**
 * SAYCAD REFERENCE GRID — flag 66ce81b5 (owner, 2026-07-24):
 *
 *   "for saycad the grid should be fixed at the background with an option to
 *    overlay or remove completely."
 *
 * Three states, not two, because "fixed at the background" and "overlay" are
 * different requests and the note asks for both:
 *
 *   background — the default. The grid is drawn BEHIND the model: it is
 *                depth-tested and depth-written like ordinary geometry, so the
 *                scan occludes it. It reads as a floor the case sits on.
 *   overlay    — the same grid drawn ON TOP of everything, depthTest off, so
 *                you can read alignment straight through the model. This is a
 *                measuring mode, not a prettier default.
 *   off        — removed completely.
 *
 * WORLD-FIXED, NOT CAMERA-FIXED. The grid lives in scene space on the Y=0
 * plane and does not follow the camera. That is what makes it a reference at
 * all: a grid pinned to the camera moves with your eye and can never tell you
 * whether the model is level, which is the one question a technician asks it.
 *
 * Kept free of any renderer/DOM dependency so the state machine and sizing
 * maths are unit-testable without a GPU.
 */

export type GridMode = 'background' | 'overlay' | 'off'

/** Cycle order for the toggle key. Deliberately ends on 'off' so repeated
 *  presses always reach "gone" rather than oscillating between two visible
 *  states — "remove completely" is an explicit ask in the flag. */
export const GRID_CYCLE: readonly GridMode[] = ['background', 'overlay', 'off']

export function nextGridMode(current: GridMode): GridMode {
  const i = GRID_CYCLE.indexOf(current)
  return GRID_CYCLE[(i + 1) % GRID_CYCLE.length]
}

const STORAGE_KEY = 'saycad.grid'

export function isGridMode(v: unknown): v is GridMode {
  return v === 'background' || v === 'overlay' || v === 'off'
}

/** Persisted preference. An unreadable or unknown value falls back to the
 *  default rather than throwing — a corrupt preference must never be able to
 *  stop the editor from opening. */
export function loadGridMode(): GridMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return isGridMode(raw) ? raw : 'background'
  } catch {
    return 'background'
  }
}

export function saveGridMode(mode: GridMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* preference persistence must never break the editor */
  }
}

/**
 * Grid extent and division count for a scene of radius `r` (mm).
 *
 * Divisions are derived from a FIXED 1mm minor cell rather than a constant
 * count, so a square on screen always means the same real distance. A grid
 * whose cell size silently changes with zoom looks like a ruler and lies like
 * one — the whole point of the reference is that you can count squares.
 *
 * Cell size steps 1 → 2 → 5 → 10mm as the case grows, keeping the line count
 * bounded (a 200mm arch at 1mm would be 400 lines of overdraw for detail no
 * one can resolve on screen).
 */
export function gridSpecFor(radiusMm: number): {
  size: number
  divisions: number
  cellMm: number
} {
  const r = Number.isFinite(radiusMm) && radiusMm > 0 ? radiusMm : 20
  // Extent comfortably clears the model so the floor reads as a plane, not a mat.
  const size = Math.max(20, Math.ceil((r * 3) / 10) * 10)
  const cellMm = size <= 60 ? 1 : size <= 120 ? 2 : size <= 300 ? 5 : 10
  return { size, divisions: Math.round(size / cellMm), cellMm }
}

export interface ReferenceGrid {
  readonly object: THREE.Object3D
  readonly mode: GridMode
  setMode(mode: GridMode): void
  /** Re-fit the grid to a new scene radius (model loaded / swapped). */
  resize(radiusMm: number): void
  dispose(): void
}

/**
 * Build the grid object. `THREE.GridHelper` draws a 1x1-cell grid on the XZ
 * plane centred at the origin — which is the Y=0 floor the scans already sit
 * on, so no extra transform is needed.
 */
export function createReferenceGrid(radiusMm: number, initial: GridMode = 'background'): ReferenceGrid {
  const group = new THREE.Group()
  group.name = 'saycad-reference-grid'

  let helper: THREE.GridHelper | null = null
  let mode: GridMode = initial

  const build = (r: number): void => {
    if (helper) {
      group.remove(helper)
      helper.geometry.dispose()
      disposeMaterial(helper.material)
      helper = null
    }
    const { size, divisions } = gridSpecFor(r)
    // Major axis lines a touch stronger than the minor cells so the origin
    // stays findable without the grid competing with the model.
    helper = new THREE.GridHelper(size, divisions, 0x8fb0a5, 0xd7e4df)
    helper.name = 'saycad-grid-helper'
    group.add(helper)
    applyMode()
  }

  const applyMode = (): void => {
    group.visible = mode !== 'off'
    if (!helper) return
    const overlay = mode === 'overlay'
    for (const m of materialsOf(helper.material)) {
      m.transparent = true
      // Background sits quieter; overlay has to stay readable through geometry.
      m.opacity = overlay ? 0.55 : 0.32
      m.depthTest = !overlay
      m.depthWrite = !overlay
      m.needsUpdate = true
    }
    // Overlay draws last so it lands on top of the model rather than z-fighting
    // it; background renders with normal ordering.
    helper.renderOrder = overlay ? 999 : 0
  }

  build(radiusMm)

  return {
    object: group,
    get mode() {
      return mode
    },
    setMode(next: GridMode) {
      mode = next
      applyMode()
    },
    resize(r: number) {
      build(r)
    },
    dispose() {
      if (!helper) return
      group.remove(helper)
      helper.geometry.dispose()
      disposeMaterial(helper.material)
      helper = null
    }
  }
}

function materialsOf(m: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(m) ? m : [m]
}

function disposeMaterial(m: THREE.Material | THREE.Material[]): void {
  for (const one of materialsOf(m)) one.dispose()
}
