import { describe, expect, it } from 'vitest'
import { applyDab, applyGrab, falloff } from '../brush'
import { toLocal, type Vec3 } from '../geom'
import { autoDesign, prepareCase } from '../pipeline'
import { syntheticMolarCase } from '../synthetic'

const c = syntheticMolarCase()
const base = autoDesign(prepareCase({ toothNumber: 19, prep: c.prep, antagonist: c.antagonist }), { tap: c.tapPoint })
const nu = base.outer.grid.nu
const nv = base.outer.grid.nv
const positions = (): Float32Array => Float32Array.from(base.crown.getAttribute('position').array as ArrayLike<number>)
const at = (p: Float32Array, k: number): Vec3 => [p[3 * k], p[3 * k + 1], p[3 * k + 2]]
/** The crown's highest outer vertex along the occlusal axis (a cusp area). */
function topVertex(p: Float32Array): number {
  let best = 0
  let h = -Infinity
  for (let k = nu; k < nu * nv; k++) {
    const y = toLocal(base.frame, at(p, k))[1]
    if (y > h) {
      h = y
      best = k
    }
  }
  return best
}
function reshape(p: Float32Array, keep: boolean) {
  const n = nu * nv
  const pts = new Float64Array(n * 3)
  for (let k = 0; k < n; k++) {
    const q = toLocal(base.frame, at(p, k))
    pts.set(q, 3 * k)
  }
  return base.rebuild!({ pts, pole: toLocal(base.frame, at(p, n)) }, { keepMinThickness: keep })
}

describe('brush', () => {
  it('falls off smoothly to zero at the radius', () => {
    expect(falloff(0, 1)).toBe(1)
    expect(falloff(1, 1)).toBe(0)
    expect(falloff(0.5, 1)).toBeGreaterThan(falloff(0.8, 1))
  })

  it('adds material outward under the brush and leaves the margin row alone', () => {
    const p = positions()
    const before = p.slice()
    const k = topVertex(p)
    const r = applyDab(p, nu, nv, { mode: 'add', center: at(p, k), radiusMm: 1.5, strength: 0.2 })
    expect(r.moved).toBeGreaterThan(3)
    expect(r.maxMoveMm).toBeCloseTo(0.2, 2)
    // The top vertex rose along the occlusal axis.
    expect(toLocal(base.frame, at(p, k))[1]).toBeGreaterThan(toLocal(base.frame, at(before, k))[1] + 0.1)
    for (let q = 0; q < nu * 3; q++) expect(p[q]).toBe(before[q])
    // Nothing outside the radius moved.
    let far = 0
    for (let q = 0; q < nu * nv; q++) {
      const d = Math.hypot(before[3 * q] - before[3 * k], before[3 * q + 1] - before[3 * k + 1], before[3 * q + 2] - before[3 * k + 2])
      if (d > 1.6 && (p[3 * q] !== before[3 * q] || p[3 * q + 1] !== before[3 * q + 1] || p[3 * q + 2] !== before[3 * q + 2])) far++
    }
    expect(far).toBe(0)
  })

  it('smooth and flatten pull the brushed area toward its neighbours / plane', () => {
    const p = positions()
    const k = topVertex(p)
    const c0 = at(p, k)
    // Roughen, then smooth: the bump comes most of the way back down.
    applyDab(p, nu, nv, { mode: 'add', center: c0, radiusMm: 0.6, strength: 0.3 })
    const bumped = toLocal(base.frame, at(p, k))[1]
    for (let s = 0; s < 10; s++) applyDab(p, nu, nv, { mode: 'smooth', center: c0, radiusMm: 1.5, strength: 0.6 })
    expect(toLocal(base.frame, at(p, k))[1]).toBeLessThan(bumped - 0.1)
    const q = positions()
    for (let s = 0; s < 5; s++) applyDab(q, nu, nv, { mode: 'flatten', center: at(q, k), radiusMm: 2, strength: 0.8 })
    expect(toLocal(base.frame, at(q, k))[1]).toBeLessThan(toLocal(base.frame, at(positions(), k))[1])
  })
})

describe('reshape (manual edit re-check)', () => {
  it('rebuilds a closed solid and re-runs the checks on the edited surface', () => {
    const p = positions()
    applyDab(p, nu, nv, { mode: 'add', center: at(p, topVertex(p)), radiusMm: 1.5, strength: 0.1 })
    const r = reshape(p, false)
    expect(r.watertight.watertight).toBe(true)
    expect(r.report.results.find((x) => x.id === 'watertight')!.verdict).toBe('pass')
    expect(r.crown.getAttribute('position').count).toBe(base.crown.getAttribute('position').count)
  })

  it('flags a carved-through spot, and keep-minimal-thickness pushes it back out', () => {
    const p = positions()
    // The thinnest measured spot on the occlusal half of the crown.
    let k = -1
    for (let q = Math.round(nu * nv * 0.6); q < nu * nv; q++) if (Number.isFinite(base.report.thickness[q]) && (k < 0 || base.report.thickness[q] < base.report.thickness[k])) k = q
    const c0 = at(p, k)
    for (let s = 0; s < 8; s++) applyDab(p, nu, nv, { mode: 'remove', center: c0, radiusMm: 1.2, strength: 0.25 })
    const carved = reshape(p, false)
    expect(carved.report.results.find((x) => x.id === 'thickness-occlusal')!.verdict).not.toBe('pass')
    const kept = reshape(p, true)
    expect(kept.report.results.find((x) => x.id === 'thickness-occlusal')!.verdict).toBe('pass')
    expect(kept.watertight.watertight).toBe(true)
  })
})

describe('distance maps', () => {
  it('give the occlusal gap and contact gap per outer vertex, agreeing with the checks', () => {
    const { occlusalGap, proximalGap } = base.maps
    expect(occlusalGap.length).toBe(nu * nv)
    const occ = Array.from(occlusalGap).filter(Number.isFinite)
    expect(occ.length).toBeGreaterThan(10)
    // The map's closest point is the occlusion check's measurement.
    const minOcc = Math.min(...occ)
    expect(Math.abs(minOcc - base.report.summary.occlusalMinMm!)).toBeLessThan(0.02)
    const prox = Array.from(proximalGap).filter(Number.isFinite)
    expect(prox.length).toBeGreaterThan(10)
  })

  it('are recomputed for an edited surface', () => {
    const p = positions()
    applyDab(p, nu, nv, { mode: 'add', center: at(p, topVertex(p)), radiusMm: 1.5, strength: 0.15 })
    const r = reshape(p, false)
    const before = Math.min(...Array.from(base.maps.occlusalGap).filter(Number.isFinite))
    const after = Math.min(...Array.from(r.maps.occlusalGap).filter(Number.isFinite))
    expect(after).toBeLessThan(before)
  })
})

describe('grab', () => {
  it('moves the grabbed point by the drag and leaves the margin and far surface in place', () => {
    const from = positions()
    const p = from.slice()
    const k = topVertex(from)
    const t: [number, number, number] = [0.3 * base.frame.occlusal[0], 0.3 * base.frame.occlusal[1], 0.3 * base.frame.occlusal[2]]
    applyGrab(from, p, nu, nv, at(from, k), t, 2)
    const moved = Math.hypot(p[3 * k] - from[3 * k], p[3 * k + 1] - from[3 * k + 1], p[3 * k + 2] - from[3 * k + 2])
    expect(moved).toBeCloseTo(0.3, 3)
    for (let q = 0; q < nu * 3; q++) expect(p[q]).toBe(from[q])
    const r = reshape(p, false)
    expect(r.watertight.watertight).toBe(true)
    // Raised 0.3 mm into the bite: the occlusion check sees it.
    expect(Math.min(...Array.from(r.maps.occlusalGap).filter(Number.isFinite))).toBeLessThan(Math.min(...Array.from(base.maps.occlusalGap).filter(Number.isFinite)))
  })
})

describe('brush edits across a redesign', () => {
  it('re-applies the sculpt to a moved and rotated design in the tooth frame', async () => {
    const { editOffsets, applyOffsets, maxOffset } = await import('../manualEdits')
    const n = nu * nv + 1
    const auto = positions().slice(0, n * 3)
    const edited = auto.slice()
    applyDab(edited, nu, nv, { mode: 'add', center: at(edited, topVertex(edited)), radiusMm: 1.5, strength: 0.2 })
    const off = editOffsets(auto, edited, base.frame)
    expect(maxOffset(off)).toBeCloseTo(0.2, 2)
    // Same edits on the same surface reproduce the edit exactly.
    const again = applyOffsets(auto, off, base.frame)
    for (let q = 0; q < again.length; q++) expect(again[q]).toBeCloseTo(edited[q], 4)
    // A frame turned 90° about the occlusal axis: the bump follows the tooth, not the world.
    const f = base.frame
    const turned = { ...f, mesial: f.buccal, buccal: [-f.mesial[0], -f.mesial[1], -f.mesial[2]] as [number, number, number] }
    const moved = applyOffsets(auto, off, turned)
    const k = topVertex(auto)
    const d = [moved[3 * k] - auto[3 * k], moved[3 * k + 1] - auto[3 * k + 1], moved[3 * k + 2] - auto[3 * k + 2]]
    const occ = d[0] * f.occlusal[0] + d[1] * f.occlusal[1] + d[2] * f.occlusal[2]
    const editOcc = off[3 * k + 1]
    expect(occ).toBeCloseTo(editOcc, 4)
  })
})
