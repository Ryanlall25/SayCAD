import * as THREE from 'three'
import { toothClassOf, type ToothClass } from './anatomy'
import { mesialSign } from './frame'
import { add, cross, dot, normalize, scale, sub, type ToothFrame, type Vec3 } from './geom'
import type { CrownGrid } from './grid'
import { weld } from './slice'
import { normaliseToReference, sampleCrownOuter, trainShapeModel, type ShapeModel } from './ssm'

/**
 * Importing a third-party tooth library (exocad-style: one STL per tooth,
 * laid out in arch position, open at the cervical) as anatomy templates.
 *
 * Library files are NOT bundled with SayCAD: they carry their publisher's
 * licence. A lab downloads the library it is entitled to and runs
 * `npm run import-library`, which writes models next to the app (git-ignored).
 *
 * Each tooth's frame is derived from the library itself: occlusal = from the
 * cervical opening toward the crown, buccal = away from the centre of the
 * arch the library's teeth form, mesial from the tooth number.
 */

export interface LibraryTooth {
  name: string
  toothNumber: number
  geometry: THREE.BufferGeometry
}

/** Universal number from a file name; FDI (11–48) is converted when `fdi`. */
export function libraryToothNumber(fileName: string, numbering: 'universal' | 'fdi' | 'auto', all: string[] = []): number | null {
  const n = numberIn(fileName)
  if (n === null) return null
  const useFdi = numbering === 'fdi' || (numbering === 'auto' && all.map(numberIn).some((x) => x !== null && x > 32))
  return useFdi ? fdiToUniversal(n) : n >= 1 && n <= 32 ? n : null
}

function numberIn(f: string): number | null {
  const m = /(?:^|[^0-9])(\d{1,2})(?=[^0-9]|$)/.exec(f.replace(/\.(stl|ply|obj)$/i, ''))
  return m ? Number(m[1]) : null
}

export function fdiToUniversal(fdi: number): number | null {
  const q = Math.floor(fdi / 10)
  const t = fdi % 10
  if (t < 1 || t > 8) return null
  if (q === 1) return 9 - t
  if (q === 2) return 8 + t
  if (q === 3) return 25 - t
  if (q === 4) return 24 + t
  return null
}

function centroid(g: THREE.BufferGeometry): Vec3 {
  const p = g.getAttribute('position') as THREE.BufferAttribute
  const c: Vec3 = [0, 0, 0]
  for (let i = 0; i < p.count; i++) {
    c[0] += p.getX(i) / p.count
    c[1] += p.getY(i) / p.count
    c[2] += p.getZ(i) / p.count
  }
  return c
}

/** Centroid of the open boundary (the cervical opening), or null if closed. */
function boundaryCentroid(g: THREE.BufferGeometry): Vec3 | null {
  const idx = g.index as THREE.BufferAttribute
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const count = new Map<string, [number, number, number]>()
  for (let t = 0; t < idx.count; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx.getX(t + e)
      const b = idx.getX(t + ((e + 1) % 3))
      const k = a < b ? `${a},${b}` : `${b},${a}`
      const r = count.get(k)
      if (r) r[2]++
      else count.set(k, [a, b, 1])
    }
  }
  const verts = new Set<number>()
  for (const [a, b, n] of count.values()) if (n === 1) verts.add(a).add(b)
  if (verts.size < 8) return null
  const c: Vec3 = [0, 0, 0]
  for (const v of verts) {
    c[0] += pos.getX(v) / verts.size
    c[1] += pos.getY(v) / verts.size
    c[2] += pos.getZ(v) / verts.size
  }
  return c
}

export interface ImportedTooth {
  name: string
  toothNumber: number
  cls: ToothClass
  frame: ToothFrame
  shape: CrownGrid | null
  error?: string
}

export function analyseLibrary(teeth: LibraryTooth[]): ImportedTooth[] {
  const welded = teeth.map((t) => ({ ...t, geometry: weld(t.geometry) }))
  const info = welded.map((t) => {
    const c = centroid(t.geometry)
    const base = boundaryCentroid(t.geometry)
    return { t, c, base }
  })
  // Common occlusal direction per arch (upper/lower), from the cervical openings.
  const archUp = (upper: boolean): Vec3 => {
    let s: Vec3 = [0, 0, 0]
    for (const i of info) if ((i.t.toothNumber <= 16) === upper && i.base) s = add(s, normalize(sub(i.c, i.base)))
    return normalize(s)
  }
  const upU = archUp(true)
  const upL = archUp(false)
  return info.map(({ t, c, base }) => {
    const cls = toothClassOf(t.toothNumber)
    const upper = t.toothNumber <= 16
    let u = base ? normalize(sub(c, base)) : upper ? upU : upL
    if (dot(u, u) === 0) u = upper ? upU : upL
    // Buccal is perpendicular to the local arch tangent (Universal numbers run
    // continuously around each arch, so the nearest-numbered neighbours give
    // it), on the side away from the arch's centroid.
    const same = info.filter((i) => (i.t.toothNumber <= 16) === upper).sort((x, y) => x.t.toothNumber - y.t.toothNumber)
    const k = same.findIndex((i) => i.t === t)
    const prev = same[Math.max(0, k - 1)].c
    const next = same[Math.min(same.length - 1, k + 1)].c
    const arch = same.reduce((a, i) => add(a, scale(i.c, 1 / same.length)), [0, 0, 0] as Vec3)
    let b = normalize(cross(u, sub(next, prev)))
    if (dot(b, sub(c, arch)) < 0) b = scale(b, -1)
    const frame: ToothFrame = {
      origin: base ?? c,
      occlusal: u,
      buccal: b,
      mesial: scale(normalize(cross(u, b)), mesialSign(t.toothNumber))
    }
    if (same.length < 3 || dot(b, b) === 0) {
      return { name: t.name, toothNumber: t.toothNumber, cls, frame, shape: null, error: 'need at least 3 teeth of the same arch to find buccal' }
    }
    const sampled = sampleCrownOuter(t.geometry, frame, 128, 56)
    if (!sampled) return { name: t.name, toothNumber: t.toothNumber, cls, frame, shape: null, error: 'could not trace the tooth outline' }
    return { name: t.name, toothNumber: t.toothNumber, cls, frame, shape: normaliseToReference(sampled.grid, cls) }
  })
}

/** One model per tooth class from the library's teeth (mean = the library's form). */
export function libraryModels(imported: ImportedTooth[], source: string): Partial<Record<ToothClass, ShapeModel>> {
  const by = new Map<ToothClass, CrownGrid[]>()
  for (const t of imported) if (t.shape) (by.get(t.cls) ?? by.set(t.cls, []).get(t.cls)!).push(t.shape)
  const out: Partial<Record<ToothClass, ShapeModel>> = {}
  for (const [cls, grids] of by) out[cls] = trainShapeModel(cls, grids, { source: `${source} (${grids.length} teeth)` })
  return out
}
