import * as THREE from 'three'
import { add, cross, dot, normalize, pca3, scale, sub, type ToothFrame, type Vec3 } from './geom'
import { buildIntaglio } from './intaglio'
import { marginRowAt } from './pipeline'
import { weld } from './slice'

/**
 * Path of insertion, chosen the way a technician (or exocad's default) does:
 * the direction along which the prep has the least undercut, so the least
 * has to be blocked out — kept near the given axis, since anatomy follows
 * it. Searches a cone around `up0` coarse-to-fine, scoring each direction
 * by the blocked-out volume of a coarse intaglio plus a small tilt cost.
 */
/**
 * Where the insertion-axis search starts: the margin loop's own plane normal,
 * on the side of `up` — the same for a margin the engine found and one the
 * technician drew. Starting from the detector's own axis instead tilted the
 * result 18–23° on lab cases whose margins agreed to 0.04 mm.
 */
export function marginNormal(margin: Vec3[], up: Vec3): Vec3 {
  const n = pca3(margin).axes[0]
  return normalize(dot(n, up) < 0 ? scale(n, -1) : n)
}

export function insertionAxis(prep: THREE.BufferGeometry, margin: Vec3[], up0: Vec3, maxTiltDeg = 25): { axis: Vec3; blockoutMm3: number; tiltDeg: number } {
  const u0 = marginNormal(margin, up0)
  const c = margin.reduce((a, p) => add(a, scale(p, 1 / margin.length)), [0, 0, 0] as Vec3)
  const reach = Math.max(...margin.map((p) => Math.hypot(...sub(p, c)))) + 6
  // Only the stump's neighbourhood matters: crop once.
  const pos = prep.getAttribute('position') as THREE.BufferAttribute
  const idx = prep.index
  const keep: number[] = []
  const n = idx ? idx.count : pos.count
  for (let t = 0; t < n; t += 3) {
    const v = [0, 1, 2].map((k) => (idx ? idx.getX(t + k) : t + k))
    const cx = (pos.getX(v[0]) + pos.getX(v[1]) + pos.getX(v[2])) / 3 - c[0]
    const cy = (pos.getY(v[0]) + pos.getY(v[1]) + pos.getY(v[2])) / 3 - c[1]
    const cz = (pos.getZ(v[0]) + pos.getZ(v[1]) + pos.getZ(v[2])) / 3 - c[2]
    if (cx * cx + cy * cy + cz * cz > reach * reach) continue
    for (const k of v) keep.push(pos.getX(k), pos.getY(k), pos.getZ(k))
  }
  const soup = new THREE.BufferGeometry()
  soup.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(keep), 3))
  // The slicer chains cut segments through shared vertices.
  const crop = weld(soup)
  const cropPos = crop.getAttribute('position') as THREE.BufferAttribute
  const cropIdx = crop.index!
  const e1 = normalize(Math.abs(u0[0]) < 0.9 ? sub([1, 0, 0], scale(u0, u0[0])) : sub([0, 0, 1], scale(u0, u0[2])))
  const e2 = cross(u0, e1)
  const tilt = (a: number, b: number): Vec3 => normalize(add(add(u0, scale(e1, Math.tan((a * Math.PI) / 180))), scale(e2, Math.tan((b * Math.PI) / 180))))
  const blockout = (axis: Vec3): number => {
    const bx = normalize(Math.abs(axis[0]) < 0.9 ? sub([1, 0, 0], scale(axis, axis[0])) : sub([0, 0, 1], scale(axis, axis[2])))
    const f: ToothFrame = { origin: c, occlusal: axis, buccal: bx, mesial: cross(axis, bx) }
    const toL = (p: Vec3): Vec3 => {
      const d = sub(p, c)
      return [dot(d, f.mesial), dot(d, f.occlusal), dot(d, f.buccal)]
    }
    const local = new Float32Array(cropPos.count * 3)
    for (let i = 0; i < cropPos.count; i++) local.set(toL([cropPos.getX(i), cropPos.getY(i), cropPos.getZ(i)]), i * 3)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(local, 3))
    g.setIndex(cropIdx)
    const res = buildIntaglio(g, marginRowAt(margin.map(toL), 48), 24, { cementGapMm: 0, marginBandMm: 0.8, marginGapMm: 0 })
    // Blocked-out wall plus any overhang of the wall past the margin itself
    // (the margin row is fixed, so the blockout above can't see it).
    const ig = res.grid
    let overhang = 0
    for (let i = 0; i < ig.nu; i++) {
      const r0 = Math.hypot(ig.pts[i * 3], ig.pts[i * 3 + 2])
      let rMax = 0
      for (let j = 1; j < ig.nv; j++) rMax = Math.max(rMax, Math.hypot(ig.pts[(j * ig.nu + i) * 3], ig.pts[(j * ig.nu + i) * 3 + 2]))
      overhang += Math.max(0, rMax - r0) * ((2 * Math.PI * r0) / ig.nu)
    }
    return res.blockoutVolumeMm3 + overhang
  }
  const score = (a: number, b: number): number => blockout(tilt(a, b)) + 0.15 * Math.hypot(a, b)
  // A coarse sweep of the whole cone first: the local search alone landed on
  // different minima from starting directions a few degrees apart.
  let best = { a: 0, b: 0, s: score(0, 0) }
  for (let a = -maxTiltDeg; a <= maxTiltDeg; a += 6) {
    for (let b = -maxTiltDeg; b <= maxTiltDeg; b += 6) {
      if ((!a && !b) || Math.hypot(a, b) > maxTiltDeg) continue
      const s = score(a, b)
      if (s < best.s) best = { a, b, s }
    }
  }
  for (const step of [4, 2, 1]) {
    const centre = best
    for (const da of [-step, 0, step]) {
      for (const db of [-step, 0, step]) {
        const a = centre.a + da
        const b = centre.b + db
        if ((!da && !db) || Math.hypot(a, b) > maxTiltDeg) continue
        const s = score(a, b)
        if (s < best.s) best = { a, b, s }
      }
    }
  }
  const tiltDeg = Math.hypot(best.a, best.b)
  return { axis: tilt(best.a, best.b), blockoutMm3: best.s - 0.15 * tiltDeg, tiltDeg }
}
