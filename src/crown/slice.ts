import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { add, cross, dot, normalize, scale, sub, type Vec3 } from './geom'

/**
 * Radial cross-sections ("profiles") of a surface around an axis — the
 * primitive the margin finder and the crown sampler are both built on.
 *
 * A profile is the intersection of the surface with the half-plane that
 * contains the axis and points along direction θ. Expressed in that
 * half-plane's own 2D coordinates (r = distance from the axis, h = height
 * along it), a prep's profile reads like a dentist's drawing of the prep:
 * occlusal table, line angle, axial wall, chamfer, margin, root face,
 * gingiva.
 *
 * Triangles are pre-bucketed by angular span so each slice only tests the
 * triangles that can cross it — 180 slices of a 20k-triangle region cost a
 * few million plane tests, not 180 × the whole scan.
 */

export interface AxisFrame {
  /** A point on the axis. */
  origin: Vec3
  /** Unit axis direction (occlusal). */
  up: Vec3
  /** Unit reference direction ⟂ up — θ = 0. */
  ref: Vec3
}

export interface ProfilePoint {
  r: number
  h: number
}

export function axisFrame(origin: Vec3, up: Vec3, hint: Vec3 = [1, 0, 0]): AxisFrame {
  const u = normalize(up)
  let ref = sub(hint, scale(u, dot(hint, u)))
  if (Math.hypot(...ref) < 1e-6) {
    const alt: Vec3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]
    ref = sub(alt, scale(u, dot(alt, u)))
  }
  return { origin, up: u, ref: normalize(ref) }
}

/** Unit direction in the plane ⟂ up at angle θ from `ref` (right-handed about up). */
export function radialDir(f: AxisFrame, theta: number): Vec3 {
  const side = cross(f.up, f.ref)
  return add(scale(f.ref, Math.cos(theta)), scale(side, Math.sin(theta)))
}

/** World point from half-plane coordinates. */
export function profileToWorld(f: AxisFrame, theta: number, p: ProfilePoint): Vec3 {
  return add(add(f.origin, scale(radialDir(f, theta), p.r)), scale(f.up, p.h))
}

/** Welds near-duplicate vertices (STL loaders emit triangle soup). */
export function weld(geometry: THREE.BufferGeometry, tolerance = 1e-4): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', geometry.getAttribute('position').clone())
  if (geometry.index) g.setIndex(geometry.index.clone())
  return mergeVertices(g, tolerance)
}

interface Region {
  /** Vertex positions in axis-frame coords: [r·cos, h, r·sin] flattened (x = ref, y = up, z = side). */
  local: Float64Array
  tris: Uint32Array
  /** Angular buckets → triangle ids. */
  buckets: number[][]
}

const BUCKETS = 360

/**
 * A sliceable region: every triangle with a vertex within `radius` of the
 * axis line (and within the given height window). The geometry must be
 * welded (shared vertices) so slice segments chain into polylines.
 */
export class RadialSlicer {
  readonly frame: AxisFrame
  private readonly region: Region

  constructor(geometry: THREE.BufferGeometry, frame: AxisFrame, radius: number, hMin = -Infinity, hMax = Infinity) {
    this.frame = frame
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute
    const idx = geometry.index as THREE.BufferAttribute
    const side = cross(frame.up, frame.ref)
    const nv = pos.count
    const local = new Float64Array(nv * 3)
    const keep = new Uint8Array(nv)
    for (let i = 0; i < nv; i++) {
      const d: Vec3 = [pos.getX(i) - frame.origin[0], pos.getY(i) - frame.origin[1], pos.getZ(i) - frame.origin[2]]
      const x = dot(d, frame.ref)
      const y = dot(d, frame.up)
      const z = dot(d, side)
      local[i * 3] = x
      local[i * 3 + 1] = y
      local[i * 3 + 2] = z
      keep[i] = Math.hypot(x, z) <= radius && y >= hMin && y <= hMax ? 1 : 0
    }
    const tris: number[] = []
    const buckets: number[][] = Array.from({ length: BUCKETS }, () => [])
    const nt = idx.count / 3
    for (let t = 0; t < nt; t++) {
      const a = idx.getX(t * 3)
      const b = idx.getX(t * 3 + 1)
      const c = idx.getX(t * 3 + 2)
      if (!keep[a] && !keep[b] && !keep[c]) continue
      const id = tris.length / 3
      tris.push(a, b, c)
      // Angular span of the triangle (handles wrap-around and the axis itself).
      const angs = [a, b, c].map((v) => Math.atan2(local[v * 3 + 2], local[v * 3]))
      const rs = [a, b, c].map((v) => Math.hypot(local[v * 3], local[v * 3 + 2]))
      if (Math.min(...rs) < 0.05) {
        for (const bk of buckets) bk.push(id)
        continue
      }
      let lo = angs[0]
      let hi = angs[0]
      for (const g of angs.slice(1)) {
        let d = g - angs[0]
        while (d > Math.PI) d -= 2 * Math.PI
        while (d < -Math.PI) d += 2 * Math.PI
        lo = Math.min(lo, angs[0] + d)
        hi = Math.max(hi, angs[0] + d)
      }
      const b0 = Math.floor(((lo / (2 * Math.PI)) * BUCKETS)) - 1
      const b1 = Math.floor(((hi / (2 * Math.PI)) * BUCKETS)) + 1
      for (let k = b0; k <= b1; k++) buckets[((k % BUCKETS) + BUCKETS) % BUCKETS].push(id)
    }
    this.region = { local, tris: Uint32Array.from(tris), buckets }
  }

  get triangleCount(): number {
    return this.region.tris.length / 3
  }

  /**
   * All polylines where the surface crosses the half-plane at θ, each as
   * (r, h) points ordered from the end nearest the axis outward.
   */
  slice(theta: number): ProfilePoint[][] {
    const { local, tris, buckets } = this.region
    const ct = Math.cos(theta)
    const st = Math.sin(theta)
    // Plane through the axis: normal n = (-sinθ, 0, cosθ) in (x, y, z) local.
    const bucket = buckets[((Math.floor((theta / (2 * Math.PI)) * BUCKETS) % BUCKETS) + BUCKETS) % BUCKETS]
    const segs: Array<[number, number, ProfilePoint, ProfilePoint]> = []
    const keyPoint = new Map<number, ProfilePoint>()
    const sd = (v: number): number => {
      const d = -st * local[v * 3] + ct * local[v * 3 + 2]
      return d === 0 ? 1e-12 : d
    }
    const cross2 = (a: number, b: number, da: number, db: number): [number, ProfilePoint] | null => {
      const t = da / (da - db)
      const x = local[a * 3] + (local[b * 3] - local[a * 3]) * t
      const y = local[a * 3 + 1] + (local[b * 3 + 1] - local[a * 3 + 1]) * t
      const z = local[a * 3 + 2] + (local[b * 3 + 2] - local[a * 3 + 2]) * t
      const r = x * ct + z * st
      const key = a < b ? a * 4194304 + b : b * 4194304 + a
      return [key, { r, h: y }]
    }
    for (const id of bucket) {
      const a = tris[id * 3]
      const b = tris[id * 3 + 1]
      const c = tris[id * 3 + 2]
      const da = sd(a)
      const db = sd(b)
      const dc = sd(c)
      const hits: Array<[number, ProfilePoint]> = []
      if (da > 0 !== db > 0) hits.push(cross2(a, b, da, db)!)
      if (db > 0 !== dc > 0) hits.push(cross2(b, c, db, dc)!)
      if (dc > 0 !== da > 0) hits.push(cross2(c, a, dc, da)!)
      if (hits.length !== 2) continue
      // Only the half-plane r ≥ 0 (allow a hair across the axis to keep the
      // polyline that passes over the prep top connected).
      if (hits[0][1].r < -0.25 && hits[1][1].r < -0.25) continue
      keyPoint.set(hits[0][0], hits[0][1])
      keyPoint.set(hits[1][0], hits[1][1])
      segs.push([hits[0][0], hits[1][0], hits[0][1], hits[1][1]])
    }
    return chain(segs, keyPoint)
  }
}

/** Chains slice segments (sharing edge keys) into ordered polylines. */
function chain(segs: Array<[number, number, ProfilePoint, ProfilePoint]>, points: Map<number, ProfilePoint>): ProfilePoint[][] {
  const adj = new Map<number, number[]>()
  for (const [ka, kb] of segs) {
    if (ka === kb) continue
    ;(adj.get(ka) ?? adj.set(ka, []).get(ka)!).push(kb)
    ;(adj.get(kb) ?? adj.set(kb, []).get(kb)!).push(ka)
  }
  const visited = new Set<number>()
  const lines: ProfilePoint[][] = []
  const walk = (start: number): number[] => {
    const out = [start]
    visited.add(start)
    let prev = -1
    let cur = start
    for (;;) {
      const next = (adj.get(cur) ?? []).find((k) => k !== prev && !visited.has(k))
      if (next === undefined) break
      out.push(next)
      visited.add(next)
      prev = cur
      cur = next
    }
    return out
  }
  // Open chains first (start at degree-1 ends), then closed loops.
  for (const [k, nb] of adj) if (nb.length === 1 && !visited.has(k)) lines.push(walk(k).map((q) => points.get(q)!))
  for (const k of adj.keys()) if (!visited.has(k)) lines.push(walk(k).map((q) => points.get(q)!))
  return lines
    .filter((l) => l.length >= 2)
    .map((l) => (l[0].r <= l[l.length - 1].r ? l : l.reverse()))
}

/** Resamples a polyline at uniform arc-length spacing. */
export function resample(line: ProfilePoint[], step: number): ProfilePoint[] {
  if (line.length < 2) return line.slice()
  const out: ProfilePoint[] = [line[0]]
  let carry = 0
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    const segLen = Math.hypot(b.r - a.r, b.h - a.h)
    if (segLen < 1e-12) continue
    let t = step - carry
    while (t <= segLen) {
      out.push({ r: a.r + ((b.r - a.r) * t) / segLen, h: a.h + ((b.h - a.h) * t) / segLen })
      t += step
    }
    carry = segLen - (t - step)
  }
  const last = line[line.length - 1]
  const tail = out[out.length - 1]
  if (Math.hypot(last.r - tail.r, last.h - tail.h) > step * 0.25) out.push(last)
  return out
}

/** Gaussian smoothing of a uniformly sampled polyline (σ in samples). */
export function smoothLine(line: ProfilePoint[], sigmaSamples: number): ProfilePoint[] {
  if (sigmaSamples <= 0) return line.slice()
  const w = Math.ceil(sigmaSamples * 3)
  const kernel: number[] = []
  for (let k = -w; k <= w; k++) kernel.push(Math.exp(-(k * k) / (2 * sigmaSamples * sigmaSamples)))
  return line.map((_, i) => {
    let r = 0
    let h = 0
    let s = 0
    for (let k = -w; k <= w; k++) {
      const j = i + k
      if (j < 0 || j >= line.length) continue
      const wt = kernel[k + w]
      r += line[j].r * wt
      h += line[j].h * wt
      s += wt
    }
    return { r: r / s, h: h / s }
  })
}

/** Cumulative arc length of a polyline. */
export function arcLengths(line: ProfilePoint[]): number[] {
  const s = [0]
  for (let i = 1; i < line.length; i++) s.push(s[i - 1] + Math.hypot(line[i].r - line[i - 1].r, line[i].h - line[i - 1].h))
  return s
}
