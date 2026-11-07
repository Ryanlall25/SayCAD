import type { Vec3 } from './geom'

/**
 * Cross-sections: a plane through the crown, the prep and the opposing jaw,
 * as 2D outlines in the plane's own coordinates, plus what a technician reads
 * off a sectional view — the thinnest crown wall and the closest approach to
 * the opposing teeth in that slice.
 */

export interface SectionPlane {
  /** A point on the plane (world). */
  point: Vec3
  /** Unit normal (world). */
  normal: Vec3
  /** In-plane axes (unit, orthogonal to the normal and each other): x → right, y → up in the 2D view. */
  xAxis: Vec3
  yAxis: Vec3
}

/** 2D segments [x0, y0, x1, y1] in the plane's coordinates (mm). */
export type Segments2D = Float64Array

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Where a triangle mesh crosses the plane, as 2D segments. */
export function sliceMesh(positions: ArrayLike<number>, indices: ArrayLike<number> | null, plane: SectionPlane): Segments2D {
  const out: number[] = []
  const n = plane.normal
  const o = plane.point
  const dist = (k: number): number => (positions[3 * k] - o[0]) * n[0] + (positions[3 * k + 1] - o[1]) * n[1] + (positions[3 * k + 2] - o[2]) * n[2]
  const to2 = (k1: number, k2: number, d1: number, d2: number): [number, number] => {
    const t = d1 / (d1 - d2)
    const p: Vec3 = [
      positions[3 * k1] + t * (positions[3 * k2] - positions[3 * k1]) - o[0],
      positions[3 * k1 + 1] + t * (positions[3 * k2 + 1] - positions[3 * k1 + 1]) - o[1],
      positions[3 * k1 + 2] + t * (positions[3 * k2 + 2] - positions[3 * k1 + 2]) - o[2]
    ]
    return [dot(p, plane.xAxis), dot(p, plane.yAxis)]
  }
  const tris = indices ? indices.length / 3 : positions.length / 9
  for (let t = 0; t < tris; t++) {
    const a = indices ? indices[3 * t] : 3 * t
    const b = indices ? indices[3 * t + 1] : 3 * t + 1
    const c = indices ? indices[3 * t + 2] : 3 * t + 2
    const da = dist(a), db = dist(b), dc = dist(c)
    const pts: Array<[number, number]> = []
    if ((da > 0) !== (db > 0)) pts.push(to2(a, b, da, db))
    if ((db > 0) !== (dc > 0)) pts.push(to2(b, c, db, dc))
    if ((dc > 0) !== (da > 0)) pts.push(to2(c, a, dc, da))
    if (pts.length === 2) out.push(pts[0][0], pts[0][1], pts[1][0], pts[1][1])
  }
  return Float64Array.from(out)
}

/** Wall readings skip this band next to the margin (mm), where the wall runs to zero. */
export const MARGIN_EXCLUSION_MM = 1

/** Closest distance from point (x, y) to any segment (mm). */
function nearest(x: number, y: number, segs: Segments2D): number {
  let best = Infinity
  for (let k = 0; k < segs.length; k += 4) {
    const ax = segs[k], ay = segs[k + 1], bx = segs[k + 2], by = segs[k + 3]
    const dx = bx - ax, dy = by - ay
    const L = dx * dx + dy * dy
    const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0
    best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y))
  }
  return best
}

export interface SectionReading {
  /** Thinnest crown wall in this slice: outer outline to intaglio outline (mm), and where. */
  minThicknessMm: number | null
  thinAt: [number, number] | null
  /** Closest approach of the crown's top half to the opposing jaw's outline (mm), and where. */
  biteGapMm: number | null
  biteAt: [number, number] | null
}

/**
 * Reads a slice. `outer` / `intaglio` are the crown's two surfaces cut by the
 * plane (kept apart so the wall is measured across, not along, a surface);
 * `antagonist` the opposing jaw's cut. y is up (occlusal).
 */
export function readSection(outer: Segments2D, intaglio: Segments2D, antagonist: Segments2D | null, marginExclusionMm = MARGIN_EXCLUSION_MM): SectionReading {
  let minT = Infinity
  let thinAt: [number, number] | null = null
  if (outer.length && intaglio.length) {
    // The margin ends of the outline (lowest point each side): the wall runs to
    // zero there by design, so the reading skips the band next to them.
    const ends: Array<[number, number]> = []
    for (const side of [-1, 1]) {
      let best: [number, number] | null = null
      for (let k = 0; k < outer.length; k += 2) if (side * outer[k] >= 0 && (!best || outer[k + 1] < best[1])) best = [outer[k], outer[k + 1]]
      if (best) ends.push(best)
    }
    for (let k = 0; k < outer.length; k += 2) {
      const x = outer[k], y = outer[k + 1]
      if (ends.some(([ex, ey]) => Math.hypot(x - ex, y - ey) < marginExclusionMm)) continue
      const d = nearest(x, y, intaglio)
      if (d < minT) {
        minT = d
        thinAt = [x, y]
      }
    }
  }
  let gap = Infinity
  let biteAt: [number, number] | null = null
  if (antagonist && antagonist.length && outer.length) {
    let top = -Infinity, bottom = Infinity
    for (let k = 1; k < outer.length; k += 2) { top = Math.max(top, outer[k]); bottom = Math.min(bottom, outer[k]) }
    const mid = (top + bottom) / 2
    for (let k = 0; k < outer.length; k += 2) {
      if (outer[k + 1] < mid) continue
      const d = nearest(outer[k], outer[k + 1], antagonist)
      if (d < gap) {
        gap = d
        biteAt = [outer[k], outer[k + 1]]
      }
    }
  }
  return {
    minThicknessMm: Number.isFinite(minT) ? minT : null,
    thinAt,
    biteGapMm: Number.isFinite(gap) ? gap : null,
    biteAt
  }
}
