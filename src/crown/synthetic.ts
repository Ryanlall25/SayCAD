import * as THREE from 'three'
import { smoothstep, type Vec3 } from './geom'

/**
 * Synthetic crown cases — a reproducible stand-in for an intraoral scan,
 * used by the test suite (every engine stage is checked against the exact
 * margin and frame this generator knows) and by the in-app "demo case".
 *
 * The case is a lower-left quadrant scan (#20 second premolar, #19 first
 * molar prepped for a full-coverage crown, #18 second molar) plus an
 * opposing upper patch, laid out on a 40 mm arch arc. Everything is a
 * height field sampled at `resolutionMm`, the same way a scanner produces a
 * single connected surface: undercuts cannot exist, which matches a
 * blocked-out stone model and is enough to exercise every algorithm.
 *
 * Prep geometry (the ground truth the margin test measures against):
 *   superellipse margin outline 8.6 × 8.2 mm, scalloped (0.6 mm above the
 *   gingiva buccal/lingual, 1.3 mm interproximal), 0.6 mm radius chamfer,
 *   6° axial-wall taper, ~4.6 mm occlusal-to-gingiva prep height.
 *
 * World axes: +Y occlusal for the lower arch, +Z anterior, +X patient's left.
 */

export interface SyntheticCase {
  name: string
  toothNumber: number
  prep: THREE.BufferGeometry
  antagonist: THREE.BufferGeometry
  /** Ground truth: margin line, densely sampled, world coordinates. */
  margin: Vec3[]
  /** Ground truth: the prep's true insertion axis (unit). */
  axis: Vec3
  /** Ground truth: buccal and mesial unit vectors at the prep. */
  buccal: Vec3
  mesial: Vec3
  /** A point on the prep's occlusal surface — where a user would tap. */
  tapPoint: Vec3
  /** The prep's reduced occlusal height (top of the stump), world Y. */
  prepTopY: number
}

export interface SyntheticOptions {
  resolutionMm?: number
  /** Occlusal reduction: how far the antagonist sits above the prep top. */
  antagonistGapMm?: number
  /** Finish-line geometry. Default 'chamfer'. */
  finish?: FinishLine
  /** Buccal/lingual margin height above the gingiva, mm (default 0.6). */
  marginAboveGumMm?: number
}

const ARCH_R = 40
const MOLAR_MD = 11.0
const PREMOLAR_MD = 7.0
const MOLAR2_MD = 10.5
const PREP_A = 4.3 // margin half-width, mesiodistal
const PREP_B = 4.1 // margin half-width, buccolingual
const PREP_P = 2.6
const CHAMFER = 0.6
const TAPER_SLOPE = 1 / Math.tan((6 * Math.PI) / 180)
const PREP_TOP = 4.6

interface ToothPose {
  center: [number, number] // x, z
  mesial: [number, number]
  buccal: [number, number]
}

function poseAt(arcLen: number): ToothPose {
  const a = arcLen / ARCH_R
  return {
    center: [ARCH_R * Math.sin(a), ARCH_R * Math.cos(a)],
    mesial: [-Math.cos(a), Math.sin(a)],
    buccal: [Math.sin(a), Math.cos(a)]
  }
}

function localOf(p: ToothPose, x: number, z: number): [number, number] {
  const dx = x - p.center[0]
  const dz = z - p.center[1]
  return [dx * p.mesial[0] + dz * p.mesial[1], dx * p.buccal[0] + dz * p.buccal[1]]
}

export type FinishLine = 'chamfer' | 'shoulder' | 'featherEdge'

interface PrepConfig {
  finish: FinishLine
  gum: number
}

const superRadius = (dx: number, dz: number, a: number, b: number, p: number): number =>
  Math.pow(Math.abs(dx) ** p / a ** p + Math.abs(dz) ** p / b ** p, -1 / p)

/** Polynomial smooth minimum (k = blend width, mm). */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - (h * h * k) / 4
}

function marginHeight(cosMD: number, gum = 0.6): number {
  return gum + 0.7 * cosMD * cosMD
}

/** Prep surface height at local (xm, zb), mm, gingiva at y = 0. */
function prepHeight(xm: number, zb: number, cfg: PrepConfig = { finish: 'chamfer', gum: 0.6 }): number {
  const r = Math.hypot(xm, zb)
  const dx = r > 1e-9 ? xm / r : 1
  const dz = r > 1e-9 ? zb / r : 0
  const R = superRadius(dx, dz, PREP_A, PREP_B, PREP_P)
  const q = R - r // mm inside the margin outline along this ray
  const ym = marginHeight(dx, cfg.gum)
  let wall: number
  if (cfg.finish === 'featherEdge') {
    // No ledge: the tapered wall runs to the margin, where the unprepared
    // root continues at a different slope — a shallow, hard-to-see corner.
    wall = q < 0 ? ym + q * 4 : ym + q * TAPER_SLOPE
  } else if (cfg.finish === 'shoulder') {
    // 1.0 mm flat shoulder, 0.15 mm internal line-angle radius.
    const S = 1.0
    const r0 = 0.15
    if (q < 0) wall = ym + q * 5
    else if (q < S - r0) wall = ym
    else if (q < S) wall = ym + r0 - Math.sqrt(Math.max(0, r0 * r0 - (q - (S - r0)) ** 2))
    else wall = ym + r0 + (q - S) * TAPER_SLOPE
  } else if (q < 0) wall = ym + q * 5 // unprepared root face below the margin
  else if (q < CHAMFER) wall = ym + CHAMFER - Math.sqrt(CHAMFER * CHAMFER - q * q) // rounded chamfer floor
  else wall = ym + CHAMFER + (q - CHAMFER) * TAPER_SLOPE
  // Reduced occlusal surface: a gently domed table with shallow cusp memory.
  const top = PREP_TOP - 0.25 * (r / 3.2) ** 2 + 0.18 * Math.cos(xm * 1.1) * Math.cos(zb * 1.2)
  return smin(wall, top, 0.8)
}

/** Neighbour crown (mesa with near-vertical proximal walls + cusps). */
function neighbourHeight(xm: number, zb: number, md: number, bl: number, cusps: Array<[number, number, number]>): number {
  const r = Math.hypot(xm, zb)
  if (r < 1e-9) return 7
  const R = superRadius(xm / r, zb / r, md / 2, bl / 2, 2.4)
  const rho = r / R
  if (rho >= 1) return -Infinity
  const body = 6.6 * smoothstep(1.0, 0.86, rho)
  let detail = 0
  for (const [cx, cz, h] of cusps) detail += h * Math.exp(-((xm - cx) ** 2 + (zb - cz) ** 2) / (2 * 1.3 * 1.3))
  return body + detail * smoothstep(0.95, 0.75, rho)
}

function gingiva(x: number, z: number): number {
  const r = Math.hypot(x, z)
  const off = Math.abs(r - ARCH_R)
  return -0.09 * Math.max(0, off - 4.5) ** 2
}

function heightField(
  x0: number,
  z0: number,
  nx: number,
  nz: number,
  h: number,
  f: (x: number, z: number) => number,
  normalUp: boolean
): THREE.BufferGeometry {
  const positions = new Float32Array(nx * nz * 3)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * h
      const z = z0 + j * h
      const k = (j * nx + i) * 3
      positions[k] = x
      positions[k + 1] = f(x, z)
      positions[k + 2] = z
    }
  }
  const indices = new Uint32Array((nx - 1) * (nz - 1) * 6)
  let t = 0
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const p00 = j * nx + i
      const p10 = p00 + 1
      const p01 = p00 + nx
      const p11 = p01 + 1
      if (normalUp) {
        indices.set([p00, p01, p10, p10, p01, p11], t)
      } else {
        indices.set([p00, p10, p01, p10, p11, p01], t)
      }
      t += 6
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setIndex(new THREE.BufferAttribute(indices, 1))
  g.computeVertexNormals()
  return g
}

/** The default synthetic case: lower-left first molar (#19) crown prep. */
export function syntheticMolarCase(opts: SyntheticOptions = {}): SyntheticCase {
  const h = opts.resolutionMm ?? 0.1
  const gap = opts.antagonistGapMm ?? 2.2
  const cfg: PrepConfig = { finish: opts.finish ?? 'chamfer', gum: opts.marginAboveGumMm ?? 0.6 }

  const s0 = 34 // arc length of #19's centre from the midline
  const prepPose = poseAt(s0)
  const pm = poseAt(s0 - (MOLAR_MD / 2 + PREMOLAR_MD / 2) + 0.35)
  const m2 = poseAt(s0 + (MOLAR_MD / 2 + MOLAR2_MD / 2) - 0.35)
  const premolarCusps: Array<[number, number, number]> = [[0, 1.6, 1.1], [0, -1.8, 0.7]]
  const molarCusps: Array<[number, number, number]> = [
    [2.2, 2.2, 0.9], [-2.2, 2.2, 0.85], [2.2, -2.2, 1.0], [-2.2, -2.2, 0.9]
  ]

  const lowerAt = (x: number, z: number): number => {
    let y = gingiva(x, z)
    const [px, pz] = localOf(prepPose, x, z)
    if (Math.hypot(px, pz) < 7) y = Math.max(y, prepHeight(px, pz, cfg))
    const [ax, az] = localOf(pm, x, z)
    y = Math.max(y, neighbourHeight(ax, az, PREMOLAR_MD, 8.0, premolarCusps))
    const [bx, bz] = localOf(m2, x, z)
    y = Math.max(y, neighbourHeight(bx, bz, MOLAR2_MD, 10.2, molarCusps))
    return y
  }

  // Bounds: the three teeth plus 3 mm of gingiva.
  const pts: Array<[number, number]> = []
  for (const s of [s0 - 14, s0 - 7, s0, s0 + 7, s0 + 17]) {
    const p = poseAt(s)
    for (const off of [-8.5, 8.5]) pts.push([p.center[0] + p.buccal[0] * off, p.center[1] + p.buccal[1] * off])
  }
  const xs = pts.map((p) => p[0])
  const zs = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const z0 = Math.min(...zs)
  const nx = Math.ceil((Math.max(...xs) - x0) / h) + 1
  const nz = Math.ceil((Math.max(...zs) - z0) / h) + 1

  const prep = heightField(x0, z0, nx, nz, h, lowerAt, true)

  // Opposing upper patch: cusps hang down; never penetrates the lower teeth.
  const occlusalPlane = PREP_TOP + gap + 1.2
  const antagonistAt = (x: number, z: number): number => {
    const [px, pz] = localOf(prepPose, x, z)
    let bumps = 0
    for (const [cx, cz] of [[2.6, -1.4], [-2.6, -1.4], [0, 0.3], [2.8, 2.6], [-2.8, 2.6]]) {
      bumps += 1.15 * Math.exp(-((px - cx) ** 2 + (pz - cz) ** 2) / (2 * 1.35 * 1.35))
    }
    const raw = occlusalPlane + 0.35 - bumps
    return Math.max(raw, lowerAt(x, z) + 0.03)
  }
  const antagonist = heightField(x0, z0, nx, nz, h, antagonistAt, false)

  // Ground-truth margin: q = 0 on the outline, at the scalloped height.
  const margin: Vec3[] = []
  for (let k = 0; k < 360; k++) {
    const th = (k / 360) * Math.PI * 2
    const dx = Math.cos(th)
    const dz = Math.sin(th)
    const R = superRadius(dx, dz, PREP_A, PREP_B, PREP_P)
    const xm = dx * R
    const zb = dz * R
    const x = prepPose.center[0] + prepPose.mesial[0] * xm + prepPose.buccal[0] * zb
    const z = prepPose.center[1] + prepPose.mesial[1] * xm + prepPose.buccal[1] * zb
    margin.push([x, marginHeight(dx, cfg.gum), z])
  }

  return {
    name: 'Synthetic #19 full-crown prep',
    toothNumber: 19,
    prep,
    antagonist,
    margin,
    axis: [0, 1, 0],
    buccal: [prepPose.buccal[0], 0, prepPose.buccal[1]],
    mesial: [prepPose.mesial[0], 0, prepPose.mesial[1]],
    tapPoint: [prepPose.center[0], prepHeight(0, 0, cfg), prepPose.center[1]],
    prepTopY: prepHeight(0, 0, cfg)
  }
}

/** Mirrors a lower case into an upper one (y → −y, winding flipped):
 *  #19 becomes #14, and the antagonist becomes the lower patch. */
export function mirrorToUpper(c: SyntheticCase): SyntheticCase {
  const flip = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    const out = g.clone()
    out.applyMatrix4(new THREE.Matrix4().makeScale(1, -1, 1))
    const idx = out.index as THREE.BufferAttribute
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1)
      idx.setX(i + 1, idx.getX(i + 2))
      idx.setX(i + 2, b)
    }
    out.computeVertexNormals()
    return out
  }
  const fy = (p: Vec3): Vec3 => [p[0], -p[1], p[2]]
  return {
    ...c,
    name: c.name.replace('#19', '#14'),
    toothNumber: 33 - c.toothNumber,
    prep: flip(c.prep),
    antagonist: flip(c.antagonist),
    margin: c.margin.map(fy),
    axis: [0, -1, 0],
    tapPoint: fy(c.tapPoint),
    prepTopY: -c.prepTopY
  }
}
