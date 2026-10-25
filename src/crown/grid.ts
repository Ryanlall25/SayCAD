import type { Vec3 } from './geom'

/**
 * The crown grid — the one surface representation every design stage edits.
 *
 * A crown surface (outer or intaglio) is sampled on `nu` meridians around the
 * insertion axis × `nv` rows from the margin (row 0) toward the occlusal
 * centre, plus a shared pole. Meridian i lies in the half-plane at
 *   θ_i = 2π·i/nu, direction (sin θ, 0, cos θ) in tooth-local coordinates,
 * so θ = 0 is buccal, π/2 mesial, π lingual, 3π/2 distal. Rows are spaced by
 * normalized arc length along the meridian (t_j = j/nv, pole t = 1).
 *
 * Because the parameterization is anatomical (same (i, j) ≈ same place on
 * any crown), the grid doubles as the correspondence needed to learn a
 * statistical shape model from finished cases, and as the address space for
 * named regions ("the distobuccal cusp") the AI layer can sculpt by name.
 * Outer and intaglio grids share row 0 exactly, so stitching them yields a
 * closed, watertight solid by construction.
 */
export interface CrownGrid {
  nu: number
  nv: number
  /** nv·nu·3, row-major (row j, meridian i), tooth-local coordinates. */
  pts: Float64Array
  pole: Vec3
}

export function createGrid(nu: number, nv: number): CrownGrid {
  return { nu, nv, pts: new Float64Array(nu * nv * 3), pole: [0, 0, 0] }
}

export function cloneGrid(g: CrownGrid): CrownGrid {
  return { nu: g.nu, nv: g.nv, pts: new Float64Array(g.pts), pole: [...g.pole] as Vec3 }
}

export const thetaOf = (g: CrownGrid, i: number): number => (2 * Math.PI * i) / g.nu
export const tOf = (g: CrownGrid, j: number): number => j / g.nv

export function getP(g: CrownGrid, i: number, j: number): Vec3 {
  if (j >= g.nv) return [...g.pole] as Vec3
  const k = (j * g.nu + (((i % g.nu) + g.nu) % g.nu)) * 3
  return [g.pts[k], g.pts[k + 1], g.pts[k + 2]]
}

export function setP(g: CrownGrid, i: number, j: number, p: Vec3): void {
  if (j >= g.nv) {
    g.pole = [...p] as Vec3
    return
  }
  const k = (j * g.nu + (((i % g.nu) + g.nu) % g.nu)) * 3
  g.pts[k] = p[0]
  g.pts[k + 1] = p[1]
  g.pts[k + 2] = p[2]
}

export function forEachVertex(g: CrownGrid, fn: (i: number, j: number, p: Vec3) => void): void {
  for (let j = 0; j < g.nv; j++) for (let i = 0; i < g.nu; i++) fn(i, j, getP(g, i, j))
}

/** Angular distance between two angles, [0, π]. */
export function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI)
  if (d > Math.PI) d = 2 * Math.PI - d
  return d
}

/** Approximate outward unit normal at a grid vertex (finite differences). */
export function gridNormal(g: CrownGrid, i: number, j: number, inward = false): Vec3 {
  const pu1 = getP(g, i + 1, j)
  const pu0 = getP(g, i - 1, j)
  const pv1 = getP(g, i, Math.min(j + 1, g.nv))
  const pv0 = getP(g, i, Math.max(j - 1, 0))
  const du: Vec3 = [pu1[0] - pu0[0], pu1[1] - pu0[1], pu1[2] - pu0[2]]
  const dv: Vec3 = [pv1[0] - pv0[0], pv1[1] - pv0[1], pv1[2] - pv0[2]]
  // θ increases buccal → mesial, rows climb toward the occlusal pole; on the
  // buccal wall du ≈ +x and dv ≈ +y, so du × dv ≈ +z: outward.
  let n: Vec3 = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]]
  const l = Math.hypot(n[0], n[1], n[2]) || 1
  n = [n[0] / l, n[1] / l, n[2] / l]
  return inward ? [-n[0], -n[1], -n[2]] : n
}

/** Arc length from the margin (row 0) to each row, per meridian. */
export function marginDistances(g: CrownGrid): Float64Array {
  const out = new Float64Array(g.nu * g.nv)
  for (let i = 0; i < g.nu; i++) {
    let s = 0
    let prev = getP(g, i, 0)
    for (let j = 1; j < g.nv; j++) {
      const p = getP(g, i, j)
      s += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2])
      out[j * g.nu + i] = s
      prev = p
    }
  }
  return out
}

/**
 * Laplacian smoothing of a displacement-free grid (rows `fromRow`..nv-1 move;
 * row 0 — the margin — never moves). `weights` (per vertex, 0–1) scales the
 * step, so callers can protect regions.
 */
export function smoothGrid(g: CrownGrid, passes: number, lambda = 0.35, fromRow = 1, weights?: Float64Array): void {
  for (let p = 0; p < passes; p++) {
    const next = new Float64Array(g.pts)
    for (let j = fromRow; j < g.nv; j++) {
      for (let i = 0; i < g.nu; i++) {
        const c = getP(g, i, j)
        const a = getP(g, i - 1, j)
        const b = getP(g, i + 1, j)
        const d = getP(g, i, j - 1)
        const e = getP(g, i, j + 1)
        const w = lambda * (weights ? weights[j * g.nu + i] : 1)
        const k = (j * g.nu + i) * 3
        for (let ax = 0; ax < 3; ax++) next[k + ax] = c[ax] + w * ((a[ax] + b[ax] + d[ax] + e[ax]) / 4 - c[ax])
      }
    }
    g.pts.set(next)
    // Pole: mean of the last row.
    const last: Vec3 = [0, 0, 0]
    for (let i = 0; i < g.nu; i++) {
      const q = getP(g, i, g.nv - 1)
      last[0] += q[0] / g.nu
      last[1] += q[1] / g.nu
      last[2] += q[2] / g.nu
    }
    g.pole = [
      g.pole[0] + lambda * (last[0] - g.pole[0]),
      g.pole[1] + lambda * (last[1] - g.pole[1]),
      g.pole[2] + lambda * (last[2] - g.pole[2])
    ]
  }
}

/** Smooths a per-vertex scalar field over the grid (wrap in i, clamp in j). */
export function smoothField(g: CrownGrid, f: Float64Array, passes: number): Float64Array {
  let cur = f
  for (let p = 0; p < passes; p++) {
    const next = new Float64Array(cur.length)
    for (let j = 0; j < g.nv; j++) {
      for (let i = 0; i < g.nu; i++) {
        const at = (ii: number, jj: number): number => cur[Math.min(g.nv - 1, Math.max(0, jj)) * g.nu + (((ii % g.nu) + g.nu) % g.nu)]
        next[j * g.nu + i] = 0.4 * at(i, j) + 0.15 * (at(i - 1, j) + at(i + 1, j) + at(i, j - 1) + at(i, j + 1))
      }
    }
    cur = next
  }
  return cur
}

/** Axis-aligned bounds of the grid. */
export function gridBounds(g: CrownGrid): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  const take = (p: Vec3): void => {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p[a])
      max[a] = Math.max(max[a], p[a])
    }
  }
  forEachVertex(g, (_i, _j, p) => take(p))
  take(g.pole)
  return { min, max }
}
