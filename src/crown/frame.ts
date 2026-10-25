import * as THREE from 'three'
import { cross, dot, normalize, scale, sub, type ToothFrame, type Vec3 } from './geom'

/**
 * The anatomical tooth frame: origin at the margin centroid, occlusal along
 * the insertion axis, buccal pointing out of the arch, mesial toward the
 * midline. Every downstream stage works in this frame's local coordinates
 * (x mesial, y occlusal, z buccal), so one crown template serves all four
 * quadrants.
 *
 * Buccal is the one direction geometry alone can get wrong (a short quadrant
 * scan is nearly straight), so the estimate reports a confidence and the UI
 * offers a one-tap flip. Mesial then follows from Universal numbering:
 * with u = occlusal and b = buccal, mesial = −(u × b) for teeth 1–8 and
 * 17–24 and +(u × b) for 9–16 and 25–32.
 */

export interface FrameEstimate {
  frame: ToothFrame
  /** 0–1: how sure the buccal direction is (arch-curvature evidence). */
  buccalConfidence: number
  archRadiusMm: number | null
}

export function mesialSign(toothNumber: number): 1 | -1 {
  return (toothNumber >= 9 && toothNumber <= 16) || toothNumber >= 25 ? 1 : -1
}

export function isUpper(toothNumber: number): boolean {
  return toothNumber >= 1 && toothNumber <= 16
}

/**
 * Local arch direction from the occlusal surfaces around the prep: the
 * principal horizontal axis of the nearby tooth tops is the arch tangent,
 * and the sign of a parabola's curvature across it says which side the arch
 * centre (lingual) is on. Works on quadrant and full-arch scans alike
 * because it only looks within `radius` of the prep.
 */
function archDirection(pts: Array<[number, number]>): { buccal: [number, number]; confidence: number; radius: number | null } | null {
  const n = pts.length
  if (n < 50) return null
  let mx = 0, my = 0
  for (const [x, y] of pts) {
    mx += x / n
    my += y / n
  }
  let sxx = 0, syy = 0, sxy = 0
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2
    syy += (y - my) ** 2
    sxy += (x - mx) * (y - my)
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const t: [number, number] = [Math.cos(ang), Math.sin(ang)]
  const nn: [number, number] = [-t[1], t[0]]
  // Least squares n = a·s² + b·s + c in the (tangent, normal) frame.
  const S = [0, 0, 0, 0, 0] // Σ s^k, k = 0..4
  const R = [0, 0, 0] // Σ n·s^k
  const rows: Array<[number, number]> = []
  for (const [x, y] of pts) {
    const s = (x - mx) * t[0] + (y - my) * t[1]
    const v = (x - mx) * nn[0] + (y - my) * nn[1]
    rows.push([s, v])
    let sk = 1
    for (let k = 0; k <= 4; k++) {
      S[k] += sk
      if (k <= 2) R[k] += v * sk
      sk *= s
    }
  }
  const M = [
    [S[4], S[3], S[2]],
    [S[3], S[2], S[1]],
    [S[2], S[1], S[0]]
  ]
  const det3 = (m: number[][]): number =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const D = det3(M)
  if (Math.abs(D) < 1e-12) return null
  const rhs = [R[2], R[1], R[0]]
  const solve = (col: number): number => det3(M.map((row, r) => row.map((v, c) => (c === col ? rhs[r] : v)))) / D
  const a = solve(0)
  const b = solve(1)
  const c = solve(2)
  let rss = 0
  for (const [s, v] of rows) rss += (v - (a * s * s + b * s + c)) ** 2
  // Standard error of a: sqrt(σ² · (MᵀM)⁻¹₀₀) with (MᵀM)⁻¹₀₀ = cofactor / det.
  const sigma2 = rss / Math.max(1, n - 3)
  const cof00 = M[1][1] * M[2][2] - M[1][2] * M[2][1]
  const se = Math.sqrt(Math.max(1e-18, (sigma2 * cof00) / D))
  const z = Math.abs(a) / se
  // Arch centre lies on the side the parabola opens toward (sign of a): lingual.
  const sign = a > 0 ? -1 : 1
  return {
    buccal: [nn[0] * sign, nn[1] * sign],
    confidence: Math.max(0, Math.min(1, (z - 2) / 6)),
    radius: Math.abs(a) > 1e-9 ? 1 / (2 * Math.abs(a)) : null
  }
}

/**
 * Builds the tooth frame from the margin loop, the insertion axis and the
 * whole prep-arch scan (for arch curvature).
 */
export function estimateFrame(
  margin: Vec3[],
  occlusal: Vec3,
  toothNumber: number,
  scan: THREE.BufferGeometry,
  opts: { flipBuccal?: boolean } = {}
): FrameEstimate {
  const u = normalize(occlusal)
  const origin = margin.reduce((a, p) => [a[0] + p[0] / margin.length, a[1] + p[1] / margin.length, a[2] + p[2] / margin.length] as Vec3, [0, 0, 0] as Vec3)
  // Horizontal basis ⟂ u.
  const e1 = normalize(Math.abs(u[0]) < 0.9 ? sub([1, 0, 0], scale(u, u[0])) : sub([0, 0, 1], scale(u, u[2])))
  const e2 = cross(u, e1)
  // Occlusal-most scan points near the prep trace the local arch.
  const pos = scan.getAttribute('position') as THREE.BufferAttribute
  const stride = Math.max(1, Math.floor(pos.count / 80000))
  const near: Array<{ h: number; x: number; y: number }> = []
  for (let i = 0; i < pos.count; i += stride) {
    const d = sub([pos.getX(i), pos.getY(i), pos.getZ(i)], origin)
    const x = dot(d, e1)
    const y = dot(d, e2)
    if (x * x + y * y <= 20 * 20) near.push({ h: dot(d, u), x, y })
  }
  const hs = near.map((s) => s.h).sort((a, b) => a - b)
  const cut = hs[Math.floor(hs.length * 0.55)] ?? 0
  const top = near.filter((s) => s.h >= cut).map((s) => [s.x, s.y] as [number, number])
  const arch = archDirection(top)
  let buccal: Vec3
  let conf: number
  let archR: number | null = null
  if (arch) {
    buccal = normalize([e1[0] * arch.buccal[0] + e2[0] * arch.buccal[1], e1[1] * arch.buccal[0] + e2[1] * arch.buccal[1], e1[2] * arch.buccal[0] + e2[2] * arch.buccal[1]])
    conf = arch.confidence
    archR = arch.radius
  } else {
    buccal = e1
    conf = 0
  }
  if (opts.flipBuccal) buccal = scale(buccal, -1)
  const mesial = scale(normalize(cross(u, buccal)), mesialSign(toothNumber))
  return { frame: { origin, occlusal: u, buccal, mesial }, buccalConfidence: conf, archRadiusMm: archR }
}

/** Frame with the buccal (and so mesial) direction flipped — the UI's
 *  "buccal is the other way" button. */
export function flipFrameBuccal(f: ToothFrame): ToothFrame {
  return { ...f, buccal: scale(f.buccal, -1), mesial: scale(f.mesial, -1) }
}
