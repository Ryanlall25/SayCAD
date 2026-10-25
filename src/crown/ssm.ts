import type * as THREE from 'three'
import { anatomySpec, buildTemplate, type Template, type ToothClass } from './anatomy'
import { geometryToLocal, jacobiEigen, SurfaceIndex, type ToothFrame, type Vec3 } from './geom'
import { createGrid, getP, gridBounds, setP, type CrownGrid } from './grid'
import { arcLengths, axisFrame, RadialSlicer, resample, weld } from './slice'

/**
 * Learned anatomy: a statistical shape model (SSM) of the lab's own finished
 * crowns, one per tooth class.
 *
 * Why an SSM and not a neural network: with ~100 cases spread over a dozen
 * tooth positions, a deep generative model would memorise, not learn. A
 * PCA shape model is the standard tool at this data size — it captures the
 * lab's mean anatomy plus its main modes of variation, it is exactly
 * reproducible, and it can be inspected (each mode is a crown you can look
 * at). As the case library grows past a few hundred per class, the same
 * grid correspondence feeds a learned generator without changing the
 * pipeline around it.
 *
 * Correspondence comes for free from the crown grid: every finished crown
 * is re-sampled on the same (meridian, row) lattice in its own anatomical
 * frame, normalised to the class's reference size, and mirrored sides are
 * already aligned because the frame is anatomical (mesial/buccal), not
 * left/right.
 */

export interface ShapeModel {
  version: 1
  cls: ToothClass
  nu: number
  nv: number
  /** Number of crowns the model was learned from. */
  count: number
  /** Mean shape, flattened grid (nu·nv·3) + pole (3), reference size. */
  mean: number[]
  /** Principal modes (unit vectors, same layout as mean). */
  modes: number[][]
  /** Standard deviation along each mode, mm-scale. */
  sigmas: number[]
  /** Fraction of variance each mode explains. */
  explained: number[]
  createdAt: string
  source: string
}

const flatten = (g: CrownGrid): Float64Array => {
  const v = new Float64Array(g.pts.length + 3)
  v.set(g.pts)
  v.set(g.pole, g.pts.length)
  return v
}

const unflatten = (v: ArrayLike<number>, nu: number, nv: number): CrownGrid => {
  const g = createGrid(nu, nv)
  for (let k = 0; k < nu * nv * 3; k++) g.pts[k] = v[k]
  const n = nu * nv * 3
  g.pole = [v[n], v[n + 1], v[n + 2]]
  return g
}

/**
 * Re-samples a finished crown (its full STL — outer + intaglio) onto the
 * crown grid's outer surface, in the given tooth frame. The crown's own
 * margin is where each radial section turns back up (the lowest point of the
 * section); the outer surface is the branch that reaches the higher top.
 * Returns null if the crown can't be traced in enough meridians.
 */
export function sampleCrownOuter(crownWorld: THREE.BufferGeometry, frame: ToothFrame, nu: number, nv: number): { grid: CrownGrid; margin: Vec3[] } | null {
  const local = weld(geometryToLocal(frame, crownWorld))
  const slicer = new RadialSlicer(local, axisFrame([0, 0, 0], [0, 1, 0], [0, 0, 1]), 12)
  const grid = createGrid(nu, nv)
  const margin: Vec3[] = []
  let failures = 0
  const tops: number[] = []
  for (let i = 0; i < nu; i++) {
    const th = (2 * Math.PI * i) / nu
    const lines = slicer.slice(th)
    // The section of a crown is one polyline: outer top → margin → intaglio top.
    let best: { r: number; h: number }[] | null = null
    for (const l of lines) if (!best || l.length > best.length) best = l
    if (!best || best.length < 10) {
      failures++
      continue
    }
    let lo = 0
    for (let k = 1; k < best.length; k++) if (best[k].h < best[lo].h) lo = k
    const a = best.slice(0, lo + 1).reverse()
    const b = best.slice(lo)
    const maxH = (l: { h: number }[]): number => Math.max(...l.map((p) => p.h))
    const outer = maxH(a) >= maxH(b) ? a : b
    const m = outer[0]
    margin.push([m.r * Math.sin(th), m.h, m.r * Math.cos(th)])
    const dense = resample([...outer, { r: 0, h: outer[outer.length - 1].h }], 0.04)
    const sl = arcLengths(dense)
    const total = sl[sl.length - 1]
    let k = 0
    for (let j = 0; j < nv; j++) {
      const target = (total * j) / nv
      while (k < dense.length - 2 && sl[k + 1] < target) k++
      const t = (target - sl[k]) / Math.max(1e-9, sl[k + 1] - sl[k])
      const r = dense[k].r + (dense[k + 1].r - dense[k].r) * t
      const h = dense[k].h + (dense[k + 1].h - dense[k].h) * t
      setP(grid, i, j, [r * Math.sin(th), h, r * Math.cos(th)])
    }
    tops.push(outer[outer.length - 1].h)
  }
  if (failures > nu * 0.1) return null
  grid.pole = [0, tops.reduce((s, h) => s + h, 0) / Math.max(1, tops.length), 0]
  return { grid, margin }
}

/** Scales a grid to the class's reference dimensions (and centres it). */
export function normaliseToReference(g: CrownGrid, cls: ToothClass): CrownGrid {
  const s = anatomySpec(cls)
  const b = gridBounds(g)
  const cx = (b.max[0] + b.min[0]) / 2
  const cz = (b.max[2] + b.min[2]) / 2
  const minY = Math.min(...Array.from({ length: g.nu }, (_, i) => getP(g, i, 0)[1]))
  const ref = buildTemplate(cls, { nu: g.nu, nv: g.nv }).grid
  const rb = gridBounds(ref)
  const sx = s.mdWidth / (b.max[0] - b.min[0])
  const sz = s.blWidth / (b.max[2] - b.min[2])
  const sy = rb.max[1] / (b.max[1] - minY)
  const out = createGrid(g.nu, g.nv)
  for (let k = 0; k < g.pts.length; k += 3) {
    out.pts[k] = (g.pts[k] - cx) * sx
    out.pts[k + 1] = (g.pts[k + 1] - minY) * sy
    out.pts[k + 2] = (g.pts[k + 2] - cz) * sz
  }
  out.pole = [(g.pole[0] - cx) * sx, (g.pole[1] - minY) * sy, (g.pole[2] - cz) * sz]
  return out
}

/** Learns a shape model from normalised grids of one class. */
export function trainShapeModel(cls: ToothClass, grids: CrownGrid[], opts: { varianceKept?: number; maxModes?: number; source?: string } = {}): ShapeModel {
  if (!grids.length) throw new Error('no training shapes')
  const { nu, nv } = grids[0]
  const X = grids.map(flatten)
  const D = X[0].length
  const N = X.length
  const mean = new Float64Array(D)
  for (const x of X) for (let d = 0; d < D; d++) mean[d] += x[d] / N
  const C = X.map((x) => x.map((v, d) => v - mean[d]))
  const modes: number[][] = []
  const sigmas: number[] = []
  const explained: number[] = []
  if (N >= 2) {
    // Gram-matrix PCA (N ≪ D): eigenvectors of C·Cᵀ map to modes via Cᵀ.
    const G = Array.from({ length: N }, (_, a) => Array.from({ length: N }, (_, b) => {
      let s = 0
      for (let d = 0; d < D; d++) s += C[a][d] * C[b][d]
      return s
    }))
    const { values, vectors } = jacobiEigen(G)
    const order = values.map((v, k) => [v, k] as const).sort((p, q) => q[0] - p[0])
    const total = values.reduce((s, v) => s + Math.max(0, v), 0) || 1
    const keep = opts.varianceKept ?? 0.95
    const maxModes = Math.min(opts.maxModes ?? 12, N - 1)
    let cum = 0
    for (const [val, k] of order) {
      if (modes.length >= maxModes || val <= 1e-9 || cum >= keep) break
      const m = new Float64Array(D)
      for (let a = 0; a < N; a++) for (let d = 0; d < D; d++) m[d] += vectors[a][k] * C[a][d]
      let norm = 0
      for (let d = 0; d < D; d++) norm += m[d] * m[d]
      norm = Math.sqrt(norm) || 1
      modes.push(Array.from(m, (v) => v / norm))
      sigmas.push(Math.sqrt(val / Math.max(1, N - 1)))
      explained.push(val / total)
      cum += val / total
    }
  }
  return {
    version: 1,
    cls,
    nu,
    nv,
    count: N,
    mean: Array.from(mean),
    modes,
    sigmas,
    explained,
    createdAt: new Date().toISOString(),
    source: opts.source ?? 'lab cases'
  }
}

/** Shape for given mode coefficients (in σ units, clamped to ±3σ). */
export function synthesise(model: ShapeModel, coeffs: number[] = []): CrownGrid {
  const v = Float64Array.from(model.mean)
  model.modes.forEach((m, k) => {
    const b = Math.max(-3, Math.min(3, coeffs[k] ?? 0)) * model.sigmas[k]
    if (!b) return
    for (let d = 0; d < v.length; d++) v[d] += b * m[d]
  })
  return unflatten(v, model.nu, model.nv)
}

/** Projects a shape onto the model: coefficients (σ units) + residual RMS (mm). */
export function project(model: ShapeModel, g: CrownGrid): { coeffs: number[]; residualRms: number } {
  const x = flatten(g)
  const c = x.map((v, d) => v - model.mean[d])
  const coeffs = model.modes.map((m, k) => {
    let s = 0
    for (let d = 0; d < c.length; d++) s += c[d] * m[d]
    return s / (model.sigmas[k] || 1)
  })
  const r = Float64Array.from(c)
  model.modes.forEach((m, k) => {
    const b = coeffs[k] * model.sigmas[k]
    for (let d = 0; d < r.length; d++) r[d] -= b * m[d]
  })
  let ss = 0
  for (let d = 0; d < r.length; d += 3) ss += r[d] ** 2 + r[d + 1] ** 2 + r[d + 2] ** 2
  return { coeffs, residualRms: Math.sqrt(ss / (r.length / 3)) }
}

/**
 * A design template from a learned model, with cusp tips located the same
 * way as on the textbook template (same grid addresses ≈ same anatomy).
 */
export function templateFromModel(model: ShapeModel, coeffs: number[] = []): Template {
  const base = buildTemplate(model.cls, { nu: model.nu, nv: model.nv })
  const grid = synthesise(model, coeffs)
  // Re-locate each cusp tip to the highest vertex near its textbook address.
  const cuspTips = base.cuspTips.map((c) => {
    let best = { i: c.i, j: c.j, y: -Infinity }
    for (let dj = -4; dj <= 4; dj++) {
      for (let di = -6; di <= 6; di++) {
        const j = c.j + dj
        if (j < 1 || j >= model.nv) continue
        const p = getP(grid, c.i + di, j)
        if (p[1] > best.y) best = { i: (((c.i + di) % model.nu) + model.nu) % model.nu, j, y: p[1] }
      }
    }
    return { name: c.name, i: best.i, j: best.j }
  })
  return { spec: base.spec, grid, cuspTips }
}

/** Surface distance from each vertex of a designed grid to a reference crown
 *  surface (ignoring the band within `bandMm` of the margin). */
export function surfaceDeviation(designed: CrownGrid, reference: SurfaceIndex, bandMm = 1): { mean: number; p90: number; max: number } {
  const d: number[] = []
  for (let j = 1; j < designed.nv; j++) {
    for (let i = 0; i < designed.nu; i++) {
      const p = getP(designed, i, j)
      const m = getP(designed, i, 0)
      if (Math.hypot(p[0] - m[0], p[1] - m[1], p[2] - m[2]) < bandMm) continue
      const c = reference.closest(p, 10)
      d.push(c ? c.distance : 10)
    }
  }
  d.sort((a, b) => a - b)
  return { mean: d.reduce((s, x) => s + x, 0) / Math.max(1, d.length), p90: d[Math.floor(d.length * 0.9)] ?? 0, max: d[d.length - 1] ?? 0 }
}

export function parseShapeModel(json: string): ShapeModel | null {
  try {
    const m = JSON.parse(json) as ShapeModel
    if (m.version !== 1 || !Array.isArray(m.mean) || m.mean.length !== m.nu * m.nv * 3 + 3) return null
    return m
  } catch {
    return null
  }
}
