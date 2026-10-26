import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

/**
 * Spatial-query layer for the crown engine. Every scan and every intermediate
 * crown surface the engine reasons about is wrapped in a `SurfaceIndex`: a
 * three-mesh-bvh BVH over a position-only BufferGeometry, giving O(log n) ray
 * casts and closest-point queries. That is what makes a full auto-design
 * (tens of thousands of queries) finish in about a second on a phone.
 *
 * Sign conventions never trust the file's triangle winding — real-world STLs
 * are not reliably oriented. "Which side of this surface am I on" is answered
 * by a ray along a caller-supplied direction instead (see `signedDistance`).
 */

export type Vec3 = [number, number, number]

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z]
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
export const normalize = (a: Vec3): Vec3 => {
  const l = len(a)
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]
}
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t
]
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Position-only, indexed copy of any geometry (drops normals/uv/color so
 *  BVH building and transforms stay cheap and attribute-agnostic). */
export function positionsOnly(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const src = geometry.getAttribute('position') as THREE.BufferAttribute
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(src.array as ArrayLike<number>), 3))
  if (geometry.index) out.setIndex(new THREE.BufferAttribute(new Uint32Array(geometry.index.array), 1))
  return out
}

/** Builds an indexed geometry from raw arrays. */
export function geometryFrom(positions: ArrayLike<number>, indices: ArrayLike<number>): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(positions), 3))
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(indices), 1))
  return g
}

export interface SurfaceHit {
  point: Vec3
  distance: number
  faceIndex: number
}

const _ray = new THREE.Ray()
const _p = new THREE.Vector3()
const _target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 }

/** A BVH-accelerated surface. Owns its (position-only) geometry. */
export class SurfaceIndex {
  readonly geometry: THREE.BufferGeometry
  readonly bvh: MeshBVH
  readonly triangleCount: number

  constructor(geometry: THREE.BufferGeometry) {
    this.geometry = geometry.index ? geometry : indexed(geometry)
    this.bvh = new MeshBVH(this.geometry)
    this.triangleCount = (this.geometry.index as THREE.BufferAttribute).count / 3
  }

  /** First hit along a ray, either side of the surface. */
  raycast(origin: Vec3, dir: Vec3, near = 0, far = Infinity): SurfaceHit | null {
    _ray.origin.set(origin[0], origin[1], origin[2])
    _ray.direction.set(dir[0], dir[1], dir[2]).normalize()
    const hit = this.bvh.raycastFirst(_ray, THREE.DoubleSide, near, far)
    if (!hit) return null
    return { point: [hit.point.x, hit.point.y, hit.point.z], distance: hit.distance, faceIndex: hit.faceIndex ?? -1 }
  }

  /** Every hit along a ray, nearest first. */
  raycastAll(origin: Vec3, dir: Vec3, near = 0, far = Infinity): SurfaceHit[] {
    _ray.origin.set(origin[0], origin[1], origin[2])
    _ray.direction.set(dir[0], dir[1], dir[2]).normalize()
    return this.bvh
      .raycast(_ray, THREE.DoubleSide, near, far)
      .map((h) => ({ point: [h.point.x, h.point.y, h.point.z] as Vec3, distance: h.distance, faceIndex: h.faceIndex ?? -1 }))
      .sort((a, b) => a.distance - b.distance)
  }

  /** Closest surface point (unsigned). `maxDistance` prunes the search. */
  closest(p: Vec3, maxDistance = Infinity): SurfaceHit | null {
    _p.set(p[0], p[1], p[2])
    const r = this.bvh.closestPointToPoint(_p, _target, 0, maxDistance)
    if (!r) return null
    return { point: [r.point.x, r.point.y, r.point.z], distance: r.distance, faceIndex: r.faceIndex }
  }

  /**
   * Signed distance from p to the surface, treating the surface as a wall the
   * point approaches by travelling along `towardDir`: if a ray from p along
   * `towardDir` hits the surface, p has not crossed it yet and the distance is
   * positive; if it does not (but a ray the other way does), p has crossed —
   * it is inside the neighbouring tooth — and the distance is negative.
   *
   * Used for neighbour contacts (towardDir = ±mesial) and occlusion
   * (towardDir = occlusal). Magnitude is the true closest-point distance.
   */
  signedDistance(p: Vec3, towardDir: Vec3, maxDistance = 6): number {
    const c = this.closest(p, maxDistance)
    if (!c) return maxDistance
    const d = sub(p, c.point)
    const l = len(d)
    if (l < 1e-9) return 0
    // Which side of the wall: outside, the closest point lies ahead of p
    // (p − q points back along towardDir). Clear cases settle it directly;
    // grazing ones (closest point off to the side) fall back to a ray test.
    const cos = dot(d, normalize(towardDir)) / l
    if (cos < -0.2) return l
    if (cos > 0.2) return -l
    const ahead = this.raycast(p, towardDir, 0, maxDistance * 3)
    if (ahead) return l
    const behind = this.raycast(p, scale(towardDir, -1), 0, maxDistance * 3)
    return behind ? -l : l
  }

  /**
   * Vertical clearance from p up to this surface, for a surface lying above
   * (local +y): the first hit of a ray cast up from well below p, minus p's
   * height — negative when p is inside or past it. Unlike signedDistance it
   * needs no inside/outside test, so hollow printed models, bases and open
   * scans all read right.
   */
  gapUp(p: Vec3, maxDistance = 6): number {
    const h = this.raycast([p[0], p[1] - 40, p[2]], [0, 1, 0], 0, 40 + maxDistance)
    return h ? h.point[1] - p[1] : maxDistance
  }

  /** Face normal (from winding — only for shading/heuristics, never for sign). */
  faceNormal(faceIndex: number): Vec3 {
    const idx = this.geometry.index as THREE.BufferAttribute
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute
    const a = idx.getX(faceIndex * 3)
    const b = idx.getX(faceIndex * 3 + 1)
    const c = idx.getX(faceIndex * 3 + 2)
    const pa: Vec3 = [pos.getX(a), pos.getY(a), pos.getZ(a)]
    const pb: Vec3 = [pos.getX(b), pos.getY(b), pos.getZ(b)]
    const pc: Vec3 = [pos.getX(c), pos.getY(c), pos.getZ(c)]
    return normalize(cross(sub(pb, pa), sub(pc, pa)))
  }
}

/** Non-indexed → indexed (identity index; no welding). */
function indexed(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const count = geometry.getAttribute('position').count
  const index = new Uint32Array(count)
  for (let i = 0; i < count; i++) index[i] = i
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  return geometry
}

/** Iterates every triangle's vertex positions. */
export function forEachTriangle(
  geometry: THREE.BufferGeometry,
  fn: (a: Vec3, b: Vec3, c: Vec3, face: number) => void
): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute
  const idx = geometry.index
  const n = idx ? idx.count / 3 : pos.count / 3
  for (let f = 0; f < n; f++) {
    const ia = idx ? idx.getX(f * 3) : f * 3
    const ib = idx ? idx.getX(f * 3 + 1) : f * 3 + 1
    const ic = idx ? idx.getX(f * 3 + 2) : f * 3 + 2
    fn(
      [pos.getX(ia), pos.getY(ia), pos.getZ(ia)],
      [pos.getX(ib), pos.getY(ib), pos.getZ(ib)],
      [pos.getX(ic), pos.getY(ic), pos.getZ(ic)],
      f
    )
  }
}

/**
 * A right-handed-or-mirrored orthonormal tooth frame. Anatomical local
 * coordinates are (x = mesial, y = occlusal, z = buccal) for EVERY tooth, so
 * one template describes a left and a right tooth alike; the price is that
 * the local→world matrix is improper (det −1) on one side of the mouth, which
 * `isMirrored` records so meshes built in local space flip their winding.
 */
export interface ToothFrame {
  origin: Vec3
  mesial: Vec3
  occlusal: Vec3
  buccal: Vec3
}

export function frameIsMirrored(f: ToothFrame): boolean {
  return dot(cross(f.mesial, f.occlusal), f.buccal) < 0
}

export function toLocal(f: ToothFrame, p: Vec3): Vec3 {
  const d = sub(p, f.origin)
  return [dot(d, f.mesial), dot(d, f.occlusal), dot(d, f.buccal)]
}

export function toWorld(f: ToothFrame, q: Vec3): Vec3 {
  return [
    f.origin[0] + f.mesial[0] * q[0] + f.occlusal[0] * q[1] + f.buccal[0] * q[2],
    f.origin[1] + f.mesial[1] * q[0] + f.occlusal[1] * q[1] + f.buccal[1] * q[2],
    f.origin[2] + f.mesial[2] * q[0] + f.occlusal[2] * q[1] + f.buccal[2] * q[2]
  ]
}

export function dirToWorld(f: ToothFrame, d: Vec3): Vec3 {
  return [
    f.mesial[0] * d[0] + f.occlusal[0] * d[1] + f.buccal[0] * d[2],
    f.mesial[1] * d[0] + f.occlusal[1] * d[1] + f.buccal[1] * d[2],
    f.mesial[2] * d[0] + f.occlusal[2] * d[1] + f.buccal[2] * d[2]
  ]
}

/** Column-major Matrix4 (three.js layout) taking local → world. */
export function frameMatrix(f: ToothFrame): THREE.Matrix4 {
  const m = new THREE.Matrix4()
  m.set(
    f.mesial[0], f.occlusal[0], f.buccal[0], f.origin[0],
    f.mesial[1], f.occlusal[1], f.buccal[1], f.origin[1],
    f.mesial[2], f.occlusal[2], f.buccal[2], f.origin[2],
    0, 0, 0, 1
  )
  return m
}

/** Copy of `geometry` mapped into the frame's local coordinates. */
export function geometryToLocal(f: ToothFrame, geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = positionsOnly(geometry)
  g.applyMatrix4(frameMatrix(f).invert())
  return g
}

/** Area-weighted mean of a set of 3D points' principal axes (3×3 symmetric
 *  eigen-decomposition by Jacobi rotation). Returns eigenvalues ascending. */
export function pca3(points: Vec3[]): { mean: Vec3; axes: [Vec3, Vec3, Vec3]; values: [number, number, number] } {
  const n = points.length
  const mean: Vec3 = [0, 0, 0]
  for (const p of points) {
    mean[0] += p[0] / n
    mean[1] += p[1] / n
    mean[2] += p[2] / n
  }
  const c = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  for (const p of points) {
    const d = sub(p, mean)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i][j] += (d[i] * d[j]) / n
  }
  const { values, vectors } = jacobiEigen(c)
  const order = [0, 1, 2].sort((a, b) => values[a] - values[b])
  return {
    mean,
    axes: order.map((k) => [vectors[0][k], vectors[1][k], vectors[2][k]] as Vec3) as [Vec3, Vec3, Vec3],
    values: order.map((k) => values[k]) as [number, number, number]
  }
}

/** Symmetric eigen-decomposition (cyclic Jacobi). Works for any n×n. */
export function jacobiEigen(input: number[][], sweeps = 60): { values: number[]; vectors: number[][] } {
  const n = input.length
  const a = input.map((r) => r.slice())
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  for (let s = 0; s < sweeps; s++) {
    let off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j]
    if (off < 1e-22) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const cs = 1 / Math.sqrt(t * t + 1)
        const sn = t * cs
        for (let k = 0; k < n; k++) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = cs * akp - sn * akq
          a[k][q] = sn * akp + cs * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = cs * apk - sn * aqk
          a[q][k] = sn * apk + cs * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p]
          const vkq = v[k][q]
          v[k][p] = cs * vkp - sn * vkq
          v[k][q] = sn * vkp + cs * vkq
        }
      }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: v }
}
