import { clamp, dist, normalize, smoothstep, sub, SurfaceIndex, type Vec3 } from './geom'
import { buildTemplate, type Template, type ToothClass } from './anatomy'
import {
  angleDiff,
  cloneGrid,
  getP,
  gridBounds,
  gridNormal,
  marginDistances,
  setP,
  smoothField,
  smoothGrid,
  thetaOf,
  type CrownGrid
} from './grid'
import { MATERIALS, type MaterialId } from './materials'
import { toothSide } from './findPrep'

/**
 * The outer-surface designer: template → case. Everything is tooth-local
 * (x mesial, y occlusal, z buccal) and every step is a deterministic
 * function of (case, params), so a design is reproducible from its params
 * alone and the AI layer only ever edits params, never vertices.
 *
 * Order (constraint priority rises down the list — later steps win):
 *   1. size the template to the space: mesiodistal from the neighbours,
 *      buccolingual from the margin/neighbour proportions, height from the
 *      antagonist;
 *   2. morph the cervical third onto the actual margin line;
 *   3. user sculpt ops (by named region or grid address);
 *   4. proximal contacts to the target tightness (RBF push/pull);
 *   5. occlusion: raise cusp tips into contact, then relieve anything
 *      closer than the target clearance;
 *   6. minimum material thickness over the intaglio (structural — wins
 *      over occlusion; the resulting conflict is reported, not hidden).
 */

export type RegionName =
  | 'mesial-contact'
  | 'distal-contact'
  | 'buccal-wall'
  | 'lingual-wall'
  | 'mesial-marginal-ridge'
  | 'distal-marginal-ridge'
  | 'central-fossa'
  | 'occlusal-table'
  | string // cusp names from the template ("mesiobuccal", "buccal", …)

export interface SculptOp {
  region?: RegionName
  /** Explicit grid address (from a tap on the crown). */
  at?: { i: number; j: number }
  /** + adds material along the surface normal, − removes. */
  amountMm: number
  radiusMm: number
}

export interface DesignParams {
  material: MaterialId
  cementGapMm?: number
  marginBandMm: number
  marginGapMm: number
  minAxialMm?: number
  minOcclusalMm?: number
  marginThicknessMm?: number
  /** Target signed distance to the neighbour at the contact (negative = tighter). */
  contactMesialMm: number
  contactDistalMm: number
  /** Target closest distance to the antagonist (positive = out of occlusion). */
  occlusalClearanceMm: number
  /** Raise cusp tips to the target clearance (create occlusal stops). */
  occlusalContacts: boolean
  cuspScale: number
  grooveScale: number
  buccalBulgeMm: number
  lingualBulgeMm: number
  heightOffsetMm: number
  /** Insertion-axis tilt toward mesial (+) / distal (−), degrees. */
  axisTiltMesialDeg: number
  /** Insertion-axis tilt toward buccal (+) / lingual (−), degrees. */
  axisTiltBuccalDeg: number
  rotationDeg: number
  mdShiftMm: number
  blShiftMm: number
  sculpt: SculptOp[]
}

export const DEFAULT_PARAMS: DesignParams = {
  material: 'zirconia-hs',
  marginBandMm: 0.8,
  marginGapMm: 0.01,
  contactMesialMm: -0.03,
  contactDistalMm: -0.03,
  // The lab's crowns stand 0.08–0.09 mm off the antagonist at their closest
  // (median, 35 molars) — exocad's usual 0.1 mm antagonist distance.
  occlusalClearanceMm: 0.08,
  // Off: lifting every cusp tip into contact made crowns taller than the lab's
  // (technicians leave 0.06–0.13 mm at the closest point, 9 lower molars).
  occlusalContacts: false,
  cuspScale: 1,
  grooveScale: 1,
  buccalBulgeMm: 0,
  lingualBulgeMm: 0,
  heightOffsetMm: 0,
  axisTiltMesialDeg: 0,
  axisTiltBuccalDeg: 0,
  rotationDeg: 0,
  mdShiftMm: 0,
  blShiftMm: 0,
  sculpt: []
}

export function resolvedMaterial(p: DesignParams): {
  cementGapMm: number
  minAxialMm: number
  minOcclusalMm: number
  marginThicknessMm: number
} {
  const m = MATERIALS[p.material] ?? MATERIALS['zirconia-hs']
  return {
    cementGapMm: p.cementGapMm ?? m.cementGapMm,
    minAxialMm: p.minAxialMm ?? m.minAxialMm,
    minOcclusalMm: p.minOcclusalMm ?? m.minOcclusalMm,
    marginThicknessMm: p.marginThicknessMm ?? m.marginThicknessMm
  }
}

export interface DesignEnv {
  toothClass: ToothClass
  /** Universal number: tells first from second molars within a class. */
  toothNumber?: number
  /** Margin points at each meridian angle, local. */
  marginRow: Vec3[]
  intaglio: CrownGrid
  intaglioIndex: SurfaceIndex
  mesial: SurfaceIndex | null
  distal: SurfaceIndex | null
  antagonist: SurfaceIndex | null
  nv: number
  /** Optional learned anatomy (from ssm.ts) replacing the textbook template. */
  templateOverride?: Template
  /** Dev: called with the grid after each stage. */
  onStage?: (stage: string, g: CrownGrid) => void
}

export interface DesignMeasures {
  spaceMesialMm: number | null
  spaceDistalMm: number | null
  mdWidthMm: number
  blWidthMm: number
  heightMm: number
  verticalScale: number
  /** Opposing cusps the height was read from (0: no bite under this tooth). */
  biteProbes: number
  /** Neighbour marginal ridges the height was levelled with. */
  ridgeSides: number
  steps: string[]
  /** Contacts that could not reach the neighbour (gap left, mm). */
  openContacts: Array<{ side: 'mesial' | 'distal'; gapMm: number }>
}

export interface OuterResult {
  grid: CrownGrid
  cuspTips: Array<{ name: string; i: number; j: number }>
  measures: DesignMeasures
  /** Neighbours the design made contact with (null: none, or across an edentulous span). */
  neighbours: { mesial: SurfaceIndex | null; distal: SurfaceIndex | null }
}

/** Distance along ±x from the crown axis to a neighbour (closest approach). */
function measureSpace(n: SurfaceIndex | null, sign: 1 | -1, yLo: number, yHi: number): number | null {
  if (!n) return null
  let best = Infinity
  for (let y = yLo; y <= yHi; y += 0.5) {
    for (const z of [-2.5, -1.25, 0, 1.25, 2.5]) {
      const h = n.raycast([0, y, z], [sign, 0, 0], 0, 14)
      if (h) best = Math.min(best, h.distance)
    }
  }
  return Number.isFinite(best) ? best : null
}

/**
 * Height of a neighbour's marginal ridge beside the contact: its highest point
 * within 1.5 mm of the contact surface (local frame, y = occlusal).
 */
function neighbourRidge(n: SurfaceIndex | null, sign: 1 | -1, x: number | null): number | null {
  if (!n || x === null) return null
  let best = -Infinity
  for (let dx = 0.2; dx <= 1.5; dx += 0.325) {
    for (const z of [-2, -1, 0, 1, 2]) {
      const h = n.raycast([sign * (x + dx), 30, z], [0, -1, 0], 0, 40)
      if (h) best = Math.max(best, h.point[1])
    }
  }
  return Number.isFinite(best) ? best : null
}

/**
 * Crown length (MD) and width (BL) beyond the margin's, mm, measured on the
 * lab's own crowns in the tooth frame — [first, second] tooth of the class
 * (molars: 6, 7; premolars: 4, 5). Lower molars: 9 + 5 crowns (BL 0.11–1.05,
 * MD 0.78–2.82 for first molars; second molars barely overhang their margin).
 * Upper molars 9 + 7, upper premolars 8 + 7, lower premolars 5 + 5 crowns.
 * Classes not listed keep the earlier rule (BL at least 1.4 mm over).
 */
const OVER_MARGIN: Partial<Record<ToothClass, [{ md: number; bl: number }, { md: number; bl: number }]>> = {
  lowerMolar: [{ md: 1.6, bl: 0.55 }, { md: 0.6, bl: 0.65 }],
  upperMolar: [{ md: 1.37, bl: 0.82 }, { md: 1.17, bl: 0.6 }],
  upperPremolar: [{ md: 1.44, bl: 1.12 }, { md: 1.45, bl: 0.92 }],
  lowerPremolar: [{ md: 1.84, bl: 1.12 }, { md: 1.65, bl: 0.94 }]
}
const secondOfClass = (env: DesignEnv): boolean => {
  if (env.toothNumber === undefined) return false
  const pos = toothSide(env.toothNumber).pos
  return env.toothClass.endsWith('Molar') ? pos === 7 : pos === 5
}
const secondMolar = (env: DesignEnv): boolean => env.toothNumber !== undefined && toothSide(env.toothNumber).pos === 7
const mdOver = (env: DesignEnv): number | undefined => OVER_MARGIN[env.toothClass]?.[secondOfClass(env) ? 1 : 0].md
const blOverOf = (env: DesignEnv): number | undefined => OVER_MARGIN[env.toothClass]?.[secondOfClass(env) ? 1 : 0].bl

/** Grid address of a named region on a fitted crown. */
export function regionCentre(name: RegionName, grid: CrownGrid, cuspTips: OuterResult['cuspTips']): { i: number; j: number } | null {
  const tip = cuspTips.find((c) => c.name === name)
  if (tip) return { i: tip.i, j: tip.j }
  const at = (theta: number, t: number): { i: number; j: number } => ({
    i: Math.round((theta / (2 * Math.PI)) * grid.nu) % grid.nu,
    j: Math.min(grid.nv - 1, Math.round(t * grid.nv))
  })
  switch (name) {
    case 'mesial-contact':
      return at(Math.PI / 2, 0.42)
    case 'distal-contact':
      return at((3 * Math.PI) / 2, 0.42)
    case 'buccal-wall':
      return at(0, 0.25)
    case 'lingual-wall':
      return at(Math.PI, 0.25)
    case 'mesial-marginal-ridge':
      return at(Math.PI / 2, 0.58)
    case 'distal-marginal-ridge':
      return at((3 * Math.PI) / 2, 0.58)
    case 'central-fossa':
      return { i: 0, j: grid.nv - 1 }
    case 'occlusal-table':
      return { i: 0, j: Math.round(grid.nv * 0.85) }
    default:
      return null
  }
}

/** Displaces the grid along vertex normals with a Gaussian falloff around a vertex. */
export function applySculpt(grid: CrownGrid, centre: { i: number; j: number }, amountMm: number, radiusMm: number): void {
  const c = getP(grid, centre.i, centre.j)
  const moves: Array<[number, number, Vec3]> = []
  for (let j = 1; j < grid.nv; j++) {
    for (let i = 0; i < grid.nu; i++) {
      const p = getP(grid, i, j)
      const d = dist(p, c)
      if (d > radiusMm * 2.5) continue
      const w = Math.exp(-(d * d) / (2 * (radiusMm / 1.5) ** 2)) * smoothstep(0, 4, j)
      const n = gridNormal(grid, i, j)
      moves.push([i, j, [p[0] + n[0] * amountMm * w, p[1] + n[1] * amountMm * w, p[2] + n[2] * amountMm * w]])
    }
  }
  for (const [i, j, p] of moves) setP(grid, i, j, p)
  if (centre.j >= grid.nv - 2 || dist(c, grid.pole) < radiusMm * 2) {
    const d = dist(grid.pole, c)
    const w = Math.exp(-(d * d) / (2 * (radiusMm / 1.5) ** 2))
    grid.pole = [grid.pole[0], grid.pole[1] + amountMm * w, grid.pole[2]]
  }
}

/**
 * Moves vertices toward the prep (along ∓x) by a per-vertex amount, smoothed
 * over the grid (never below what each vertex needs), stopping each at the
 * material minimum over the fitting surface.
 */
function relieveField(
  grid: CrownGrid,
  need: Float64Array,
  sign: 1 | -1,
  wall: { intaglio: SurfaceIndex; minAxialMm: number; minOcclusalMm: number } | undefined,
  onLimit: () => void
): void {
  const { nu, nv } = grid
  let f = need
  for (let pass = 0; pass < 4; pass++) {
    const g = new Float64Array(nu * nv)
    for (let j = 1; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        let s = 0
        let c = 0
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj
          if (jj < 1 || jj >= nv) continue
          for (let di = -1; di <= 1; di++) {
            s += f[jj * nu + ((i + di + nu) % nu)]
            c++
          }
        }
        g[j * nu + i] = Math.max(need[j * nu + i], s / c)
      }
    }
    f = g
  }
  for (let j = 1; j < nv; j++) {
    const wt = smoothstep(0.015, 0.09, j / nv)
    for (let i = 0; i < nu; i++) {
      const m = f[j * nu + i] * wt
      if (m < 1e-4) continue
      const p = getP(grid, i, j)
      let q: Vec3 = [p[0] - sign * m, p[1], p[2]]
      if (wall) {
        const min = gridNormal(grid, i, j)[1] > 0.55 || j > nv * 0.6 ? wall.minOcclusalMm : wall.minAxialMm
        const dq = wall.intaglio.closest(q, min + 1)?.distance ?? Infinity
        if (dq < min) {
          // Beyond the search radius the closest point is unknown: take the
          // radius (Infinity made t = ∞/∞ = NaN and the crown came out NaN —
          // lab case029's #45 on a bridge's common axis, case084 alone).
          const dp = Math.min(wall.intaglio.closest(p, min + 1)?.distance ?? Infinity, min + 1)
          const t = dp > dq && dp > min ? (dp - min) / (dp - dq) : 0
          q = [p[0] + (q[0] - p[0]) * t, p[1], p[2]]
          onLimit()
        }
      }
      setP(grid, i, j, q)
    }
  }
}

/** RBF push/pull until the closest approach to a neighbour equals `target`. */
function enforceContact(
  grid: CrownGrid,
  n: SurfaceIndex,
  sign: 1 | -1,
  target: number,
  log: string[],
  /** Fitting surface and material minimums: a relief never thins the wall below them. */
  wall?: { intaglio: SurfaceIndex; minAxialMm: number; minOcclusalMm: number }
): { gap: number | null } {
  const sideTheta = sign > 0 ? Math.PI / 2 : (3 * Math.PI) / 2
  let limited = false
  const sigma = 2.0
  let lastE = 0
  // Candidate set: every vertex facing the neighbour on the first pass, then
  // only those that were within reach of the closest approach (each pass
  // moves the surface by at most |e|, so nothing far away can become closest).
  let candidates: Array<[number, number]> = []
  // From just above the margin: a tight neighbour often bulges at the cervical
  // third, and the critic measures contacts from row 2 up.
  for (let j = 2; j < Math.round(grid.nv * 0.8); j++) {
    for (let i = 0; i < grid.nu; i++) if (angleDiff(thetaOf(grid, i), sideTheta) <= (75 * Math.PI) / 180) candidates.push([i, j])
  }
  for (let it = 0; it < 10; it++) {
    let min = Infinity
    let at: Vec3 | null = null
    const sds: number[] = []
    for (const [i, j] of candidates) {
      const p = getP(grid, i, j)
      const sd = n.signedDistance(p, [sign, 0, 0], 5)
      sds.push(sd)
      if (sd < min) {
        min = sd
        at = p
      }
    }
    if (it === 0) candidates = candidates.filter((_, k) => sds[k] < min + Math.max(1.0, Math.abs(min - target) * 2))
    if (!at) return { gap: null }
    const e = min - target
    lastE = e
    if (Math.abs(e) < 0.005) break
    if (e > 3.5) {
      log.push(`${sign > 0 ? 'mesial' : 'distal'} neighbour ${min.toFixed(2)} mm away — too far to reach; contact left open`)
      return { gap: min }
    }
    if (e < 0) {
      // Overlap: each vertex inside the neighbour moves just clear of it, the
      // field smoothed so the wall stays fair — the proximal surface takes
      // the neighbour's shape, as a technician's adapted contact does. One
      // blob around the worst point would drag the whole wall in by its depth
      // (an overhanging neighbour: 1 mm too deep along its whole slope).
      const need = new Float64Array(grid.nu * grid.nv)
      for (const [i, j] of candidates) need[j * grid.nu + i] = Math.max(0, target - n.signedDistance(getP(grid, i, j), [sign, 0, 0], 5))
      relieveField(grid, need, sign, wall, () => (limited = true))
      continue
    }
    for (let j = 1; j < grid.nv; j++) {
      const wt = smoothstep(0.015, 0.09, j / grid.nv)
      for (let i = 0; i < grid.nu; i++) {
        const p = getP(grid, i, j)
        const d = dist(p, at)
        const w = Math.exp(-(d * d) / (2 * sigma * sigma)) * wt
        if (w < 1e-4) continue
        let q: Vec3 = [p[0] + sign * e * w, p[1], p[2]]
        if (wall && e < 0) {
          // Relieving toward the prep: stop at the material minimum (the
          // same occlusal/axial split the thickness step uses). A neighbour
          // closer to the prep than that can't get a clean contact; the
          // critic reports what is left.
          const min = gridNormal(grid, i, j)[1] > 0.55 || j > grid.nv * 0.6 ? wall.minOcclusalMm : wall.minAxialMm
          const dq = wall.intaglio.closest(q, min + 1)?.distance ?? Infinity
          if (dq < min) {
            const dp = Math.min(wall.intaglio.closest(p, min + 1)?.distance ?? Infinity, min + 1)
            const f = dp > dq && dp > min ? (dp - min) / (dp - dq) : 0
            q = [p[0] + (q[0] - p[0]) * f, p[1], p[2]]
            limited = true
          }
        }
        setP(grid, i, j, q)
      }
    }
  }
  if (limited) log.push(`${sign > 0 ? 'mesial' : 'distal'} contact relief stopped at the material minimum — the neighbour sits too close to the prep`)
  return { gap: Math.abs(lastE) < 0.02 ? null : lastE + target }
}

/**
 * Widens a point contact into a patch. enforceContact stops when the closest
 * approach reaches the target, which leaves one touching point (~1.5 mm² in
 * 0.1 mm); the lab's crowns meet their neighbours over 3–5.6 mm² (median,
 * mesial), as adult natural contacts do (1.5 mm² at 20–40 years, 4.5 mm² over
 * 40). Around the contact the wall is brought out to `target + PATCH_GAP_MM`
 * over an ellipse wider buccolingually than occlusocervically, falling off
 * smoothly, never past the neighbour. Only outward moves, so no wall thins.
 */
// Patch half-axes (buccolingual × occlusocervical, mm) per class, from
// leave-one-out runs against the lab's crowns (mesial / distal area in
// 0.1 mm, mm²; mean deviation auto / on the technician's margin, mm):
// lower molars 1.51/1.61 → 2.36/2.39 (tech 3.53/0.45), 0.160/0.168 unchanged;
// upper molars mesial 1.38 → 2.38 (tech 5.59), 0.209/0.211 → 0.208/0.211;
// upper premolars 1.61/1.75 → 2.32/2.98 (tech 2.99/3.00), 0.151/0.175 → 0.149/0.174;
// lower premolars at 1.5 × 0.9 lost 0.01 on the technician's margin, so
// 1.0 × 0.6: 1.78/1.52 → 1.98/1.94 (tech 2.31/3.56), 0.156/0.162 unchanged.
const PATCH_ENV = (globalThis as any).process?.env ?? {}
function patchAxes(cls: ToothClass): [number, number] {
  if (PATCH_ENV.PATCH_BL !== undefined) return [Number(PATCH_ENV.PATCH_BL), Number(PATCH_ENV.PATCH_OC ?? 0.9)]
  if (cls === 'lowerPremolar') return [1.0, 0.6]
  // Lower molars at 2.0 × 1.2: mesial 2.36 → 3.47 mm² (tech 3.53), deviation
  // unchanged. Upper molars at 2.5 × 1.5: mesial 2.38 → 3.89 (tech 5.59),
  // 0.208/0.211 → 0.207/0.208 (2.0 × 1.2: 3.34, unchanged).
  if (cls === 'upperMolar') return [2.5, 1.5]
  if (cls === 'lowerMolar') return [2.0, 1.2]
  if (cls === 'upperPremolar') return [1.5, 0.9]
  return [0, 0]
}
const PATCH_GAP_MM = 0.03
function widenContact(grid: CrownGrid, n: SurfaceIndex, sign: 1 | -1, target: number, cls: ToothClass): number {
  const [PATCH_BL_MM, PATCH_OC_MM] = patchAxes(cls)
  // An open contact by design (target > 0) stays a point.
  if (PATCH_BL_MM <= 0 || target > 0) return 0
  const { nu, nv } = grid
  const sideTheta = sign > 0 ? Math.PI / 2 : (3 * Math.PI) / 2
  const cand: Array<{ k: number; p: Vec3; sd: number }> = []
  let at: Vec3 | null = null
  let min = Infinity
  for (let j = 2; j < Math.round(nv * 0.85); j++) {
    for (let i = 0; i < nu; i++) {
      if (angleDiff(thetaOf(grid, i), sideTheta) > (75 * Math.PI) / 180) continue
      const p = getP(grid, i, j)
      const sd = n.signedDistance(p, [sign, 0, 0], 3)
      cand.push({ k: j * nu + i, p, sd })
      if (sd < min) { min = sd; at = p }
    }
  }
  // No contact to widen: the neighbour is out of reach.
  if (!at || min > target + 0.1) return 0
  const want = new Float64Array(nu * nv)
  const cap = new Float64Array(nu * nv).fill(0)
  for (const c of cand) {
    const room = c.sd - target
    if (!(room > 0) || room > 1.0) continue
    // Only where the neighbour lies squarely ahead: off to the side the
    // inside/outside test is a guess, and a misjudged vertex was pushed into
    // the neighbour (lower molars 021, 027: contacts −0.5 to −1.7 mm).
    const h = n.closest(c.p, room + target + 0.5)
    if (!h) continue
    const ahead = ((h.point[0] - c.p[0]) * sign) / Math.max(1e-9, Math.hypot(h.point[0] - c.p[0], h.point[1] - c.p[1], h.point[2] - c.p[2]))
    if (ahead < 0.7) continue
    cap[c.k] = Math.min(0.3, Math.max(0, room - 0.005))
    const r = Math.hypot((c.p[2] - at[2]) / PATCH_BL_MM, (c.p[1] - at[1]) / PATCH_OC_MM)
    const w = 1 - smoothstep(0.6, 1.0, r)
    if (w > 0) want[c.k] = Math.max(0, room - PATCH_GAP_MM) * w
  }
  const sm = smoothField(grid, want, 2)
  let moved = 0
  for (const c of cand) {
    const d = Math.min(sm[c.k], cap[c.k])
    if (d < 0.002) continue
    setP(grid, c.k % nu, Math.floor(c.k / nu), [c.p[0] + sign * d, c.p[1], c.p[2]])
    moved = Math.max(moved, d)
  }
  return moved
}

/** Lowers anything closer than `clearance` to the antagonist; optionally first
 *  raises cusp tips into contact. */
/**
 * The material floor under each vertex, made smooth: taken straight off the
 * scanned prep it was as rough as the scan, and a tight prep's relief —
 * clamped at it vertex by vertex — came out torn. Each vertex takes the
 * Gaussian-weighted mean of the nearby floors (σ FLOOR_SIGMA in plan view)
 * plus a small margin; envelopes of cones or caps showed through as facets
 * or dimples. Where the mean dips under a real floor, the thickness step's
 * smooth lift makes up the difference. Index −1 is the pole.
 */
const FLOOR_SIGMA = 0.8
const FLOOR_MARGIN = 0.03
function smoothFloors(grid: CrownGrid, j0: number, floorY?: (p: Vec3) => number | null): (k: number, p: Vec3) => number | null {
  if (!floorY) return () => null
  const raw: Array<[number, number, number]> = []
  for (let j = j0; j < grid.nv; j++) {
    for (let i = 0; i < grid.nu; i++) {
      const p = getP(grid, i, j)
      const f = floorY(p)
      if (f !== null) raw.push([p[0], p[2], f])
    }
  }
  const pf = floorY(grid.pole)
  if (pf !== null) raw.push([grid.pole[0], grid.pole[2], pf])
  const cache = new Map<number, number | null>()
  return (k, p) => {
    if (cache.has(k)) return cache.get(k)!
    let sw = 0
    let sf = 0
    for (const [x, z, f] of raw) {
      const d2 = (p[0] - x) ** 2 + (p[2] - z) ** 2
      if (d2 > 9 * FLOOR_SIGMA * FLOOR_SIGMA) continue
      const w = Math.exp(-d2 / (2 * FLOOR_SIGMA * FLOOR_SIGMA))
      sw += w
      sf += w * f
    }
    const v = sw > 1e-6 ? sf / sw + FLOOR_MARGIN : null
    cache.set(k, v)
    return v
  }
}

/**
 * Lowers one vertex by `d`, never below the material floor (thickness
 * outranks occlusion; the high spot left is reported by the critic).
 * Returns how far it moved.
 */
function relieveVertex(grid: CrownGrid, i: number, j: number, d: number, floor: number | null): number {
  const p = getP(grid, i, j)
  const y = floor === null ? p[1] - d : Math.max(Math.min(p[1], floor), p[1] - d)
  setP(grid, i, j, [p[0], y, p[2]])
  return p[1] - y
}

/**
 * A cusp placed into the antagonist is lowered as a whole — a smooth vertical
 * dip spread in plan view (σ 2 mm), the way a technician drops a high cusp —
 * leaving only the last 0.1 mm for the per-vertex relief to turn into a
 * contact. Relieving the whole intrusion vertex by vertex carved the opposing
 * cusp's shape into the crown (scoops, shelves, pits). Never below the
 * material floor.
 */
function lowerIntrusions(grid: CrownGrid, ant: SurfaceIndex, clearance: number, j0: number, floorOf: (k: number, p: Vec3) => number | null, log: string[]): void {
  const SIGMA = 2.0
  const src: Array<[number, number, number]> = []
  const own = new Float64Array(grid.nu * grid.nv)
  for (let j = j0; j < grid.nv; j++) {
    for (let i = 0; i < grid.nu; i++) {
      const p = getP(grid, i, j)
      const over = clearance - ant.gapUp(p, 4) - 0.1
      if (over > 0.01) src.push([p[0], p[2], over])
    }
  }
  if (!src.length) return
  const S2 = 2 * SIGMA * SIGMA
  const reach2 = 9 * SIGMA * SIGMA
  let deepest = 0
  for (let j = j0; j < grid.nv; j++) {
    const wt = smoothstep(j0, j0 + 10, j)
    for (let i = 0; i < grid.nu; i++) {
      const p = getP(grid, i, j)
      let d = 0
      for (const [x, z, o] of src) {
        const d2 = (p[0] - x) ** 2 + (p[2] - z) ** 2
        if (d2 < reach2) d = Math.max(d, o * Math.exp(-d2 / S2))
      }
      d *= wt
      if (d < 1e-3) continue
      deepest = Math.max(deepest, relieveVertex(grid, i, j, d, floorOf(j * grid.nu + i, p)))
    }
  }
  if (deepest > 0.05) log.push(`high cusps lowered up to ${deepest.toFixed(2)} mm`)
}

export function enforceOcclusion(
  grid: CrownGrid,
  ant: SurfaceIndex,
  clearance: number,
  cuspTips: OuterResult['cuspTips'],
  raise: boolean,
  log: string[],
  /** Lowest allowed y for a vertex (material floor over the intaglio), or null. */
  floorY?: (p: Vec3) => number | null
): void {
  const j0 = Math.round(grid.nv * 0.2) // from the lower wall: an upper molar's palatal wall can meet the lower lingual cusp (lab case085)
  const floorOf = smoothFloors(grid, j0, floorY)
  if (raise) {
    let raised = 0
    for (const tip of cuspTips) {
      const p = getP(grid, tip.i, tip.j)
      const sd = ant.gapUp(p, 4)
      const lift = clamp(sd - clearance, 0, 1.2)
      if (lift < 0.05) continue
      raised++
      for (let j = j0; j < grid.nv; j++) {
        for (let i = 0; i < grid.nu; i++) {
          const q = getP(grid, i, j)
          const d = dist(q, p)
          const w = Math.exp(-(d * d) / (2 * 1.4 * 1.4))
          if (w > 1e-3) setP(grid, i, j, [q[0], q[1] + lift * w, q[2]])
        }
      }
    }
    if (raised) log.push(`raised ${raised} cusp tip(s) into occlusal contact`)
  }
  lowerIntrusions(grid, ant, clearance, j0, floorOf, log)
  // Only vertices near the antagonist can ever need relief; find them once.
  let active: number[] | null = null
  // Until clear: a deep overlap (a cusp placed into the antagonist) can take
  // more than a few passes, as each re-measures from the moved surface.
  for (let it = 0; it < 20; it++) {
    const deficit = new Float64Array(grid.nu * grid.nv)
    let any = false
    const next: number[] = []
    const visit = (k: number): void => {
      const i = k % grid.nu
      const j = Math.floor(k / grid.nu)
      const sd = ant.gapUp(getP(grid, i, j), 4)
      if (sd < clearance + 0.8) next.push(k)
      const d = clearance - sd
      if (d > 0.002) {
        deficit[k] = d
        any = true
      }
    }
    if (active) for (const k of active) visit(k)
    else for (let k = j0 * grid.nu; k < grid.nu * grid.nv; k++) visit(k)
    active = next
    if (!any) break
    // The residual as small smooth dips (σ 0.5 mm): a vertex takes the
    // deepest Gaussian of a nearby deficit, so no single vertex pits.
    const src: Array<[Vec3, number]> = []
    for (let k = j0 * grid.nu; k < grid.nu * grid.nv; k++) if (deficit[k] > 0) src.push([getP(grid, k % grid.nu, Math.floor(k / grid.nu)), deficit[k]])
    for (let j = j0; j < grid.nv; j++) {
      for (let i = 0; i < grid.nu; i++) {
        const k = j * grid.nu + i
        const q = getP(grid, i, j)
        let env = deficit[k]
        for (const [c, dc] of src) {
          const d2 = (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2 + (q[2] - c[2]) ** 2
          if (d2 < 2.25 * 0.25) env = Math.max(env, dc * Math.exp(-d2 / (2 * 0.25)))
        }
        const d = env * smoothstep(j0, j0 + 10, j)
        if (d <= 0) continue
        relieveVertex(grid, i, j, d, floorOf(k, getP(grid, i, j)))
      }
    }
    const pd = ant.gapUp(grid.pole, 4)
    if (pd < clearance) {
      const f = floorOf(-1, grid.pole)
      const y = grid.pole[1] - (clearance - pd)
      grid.pole = [grid.pole[0], f === null ? y : Math.max(Math.min(grid.pole[1], f), y), grid.pole[2]]
    }
  }
}

/**
 * Where the prep is under-reduced, raise the occlusal table as one smooth
 * shape — the way a technician lifts the whole cusp — before the per-vertex
 * thickness step: each thin occlusal vertex asks for the height it lacks, the
 * request spreads in plan view as a Gaussian (σ 1.5 mm), and every vertex
 * rises by the largest request reaching it. The occlusal surface is a height
 * field over the tooth, so a smooth vertical lift can't fold it; pushing only
 * the thin vertices out left a raised lobe with a hard rim.
 */
export function raiseUnderReduced(grid: CrownGrid, intaglio: SurfaceIndex, centre: Vec3, minOcclusalMm: number, minAxialMm: number, log?: string[], bite?: { antagonist: SurfaceIndex; clearanceMm: number }): void {
  const SIGMA = 1.5
  const j0 = Math.round(grid.nv * 0.4)
  const src: Array<[number, number, number]> = []
  const own = new Float64Array(grid.nu * grid.nv)
  for (let j = j0; j < grid.nv; j++) {
    for (let i = 0; i < grid.nu; i++) {
      const p = getP(grid, i, j)
      const n = gridNormal(grid, i, j)
      // Every upward-facing vertex (cusp slopes too: left to the normal push
      // they wrinkled); slopes count against the axial minimum.
      if (n[1] < 0.25) continue
      const need = n[1] > 0.55 || j > grid.nv * 0.6 ? minOcclusalMm : minAxialMm
      const sd = intaglio.signedDistance(p, normalize(sub(centre, p)), need + 3)
      const lack = need + 0.03 - sd
      // Folded through (deeply negative) is the thickness step's to re-seat.
      if (lack > 0.01 && sd > -0.3) {
        src.push([p[0], p[2], lack / Math.max(0.45, n[1])])
        own[j * grid.nu + i] = lack / Math.max(0.45, n[1])
      }
    }
  }
  if (!src.length) return
  const S2 = 2 * SIGMA * SIGMA
  const reach2 = 9 * SIGMA * SIGMA
  // The largest request reaching each vertex, then smoothed over the grid:
  // a bare maximum of many requests left a bump at each one. What the
  // smoothing gives back, the thickness step restores.
  const lift = new Float64Array(grid.nu * grid.nv)
  for (let j = 1; j < grid.nv; j++) {
    const wt = smoothstep(j0 - 6, j0 + 2, j)
    if (wt <= 0) continue
    for (let i = 0; i < grid.nu; i++) {
      const p = getP(grid, i, j)
      let d = 0
      for (const [x, z, l] of src) {
        const d2 = (p[0] - x) ** 2 + (p[2] - z) ** 2
        if (d2 < reach2) d = Math.max(d, l * Math.exp(-d2 / S2))
      }
      lift[j * grid.nu + i] = d * wt
    }
  }
  const smooth = smoothField(grid, lift, 6)
  let maxLift = 0
  for (let j = 1; j < grid.nv; j++) {
    for (let i = 0; i < grid.nu; i++) {
      let d = smooth[j * grid.nu + i]
      const p = getP(grid, i, j)
      // What spreads in from a thin neighbour stops at the bite; a vertex's
      // own lack still wins (thickness over occlusion). Uncapped, the spread
      // lifted fossae and slopes 0.3–0.4 mm into the antagonist on preps with
      // room to spare (lab cases 054, 056: ≥ 0.76 mm of space).
      if (bite && d > own[j * grid.nu + i]) {
        const room = bite.antagonist.gapUp(p, 2) - bite.clearanceMm
        d = Math.max(own[j * grid.nu + i], Math.min(d, Math.max(0, room)))
      }
      if (d < 1e-3) continue
      setP(grid, i, j, [p[0], p[1] + d, p[2]])
      maxLift = Math.max(maxLift, d)
    }
  }
  let pd = 0
  for (const [x, z, l] of src) pd = Math.max(pd, l * Math.exp(-(x * x + z * z) / S2))
  grid.pole = [grid.pole[0], grid.pole[1] + pd, grid.pole[2]]
  log?.push(`occlusal table raised up to ${maxLift.toFixed(2)} mm over an under-reduced prep`)
}

const AXIAL_SPREAD = 3

/**
 * Point contacts, not plateaus. Relieving everything that met the antagonist
 * to the clearance left the opposing cusps pressed into the crown as flat
 * facets: on 19 lab lower molars our crowns sat within 0.1 mm of the
 * antagonist over 2.04 mm² (median) against the technicians' 0.29 mm². Each
 * contact patch keeps its most prominent point at the clearance and opens
 * away from it, CONTACT_OPEN·d² (d in plan view, mm), at most 0.25 mm and
 * never under the material floor. At 0.8 the lower molars' contact area came
 * to 0.39 mm² (technicians' 0.29; 0.3 gave 0.89).
 */
const CONTACT_OPEN = 0.8
const CONTACT_HOLD_MM = Number((globalThis as any).process?.env?.CONTACT_HOLD ?? 0.4)
function shapeContacts(grid: CrownGrid, ant: SurfaceIndex, clearance: number, floorY: ((p: Vec3) => number | null) | undefined, log: string[]): void {
  const { nu, nv } = grid
  const j0 = Math.round(nv * 0.2)
  const near: Array<{ k: number; p: Vec3; gap: number }> = []
  for (let j = j0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const p = getP(grid, i, j)
      const gap = ant.gapUp(p, 2)
      // Out to the cap (0.25) and past it: at a 0.15 mm band the drop stepped
      // from 0.1 mm to nothing at the band's edge (a ragged rim on 054).
      if (gap <= clearance + 0.3) near.push({ k: j * nu + i, p, gap })
    }
  }
  if (!near.length) return
  // The smoothed floor (as the bite step uses): clamped at the raw one, the
  // relief took the scanned prep's roughness where it reached it (054).
  const floorOf = smoothFloors(grid, j0, floorY)
  // Patches: plan-view clusters (1.5 mm); each one's centre is its closest point to the antagonist.
  near.sort((a, b) => a.gap - b.gap)
  const centres: Vec3[] = []
  const centreK: number[] = []
  for (const v of near) if (v.gap <= clearance + 0.15 && !centres.some((c) => Math.hypot(c[0] - v.p[0], c[2] - v.p[2]) < 1.5)) { centres.push(v.p); centreK.push(v.k) }
  // The drop as a field, smoothed before it is applied: per vertex it copied
  // the opposing scan's roughness into the crown (torn, dented fossae).
  const drop = new Float64Array(nu * nv)
  const centreD2 = new Float64Array(nu * nv).fill(Infinity)
  const nearestC = new Int32Array(nu * nv).fill(-1)
  for (const v of near) {
    let d2 = Infinity
    centres.forEach((c, ci) => {
      const e = (c[0] - v.p[0]) ** 2 + (c[2] - v.p[2]) ** 2
      if (e < d2) { d2 = e; nearestC[v.k] = ci }
    })
    centreD2[v.k] = d2
    // Only what sits closer than the opened target comes down.
    const target = clearance + Math.min(0.25, CONTACT_OPEN * d2)
    drop[v.k] = Math.max(0, target - v.gap)
  }
  const smooth = smoothField(grid, drop, 6)
  let opened = 0
  for (let j = j0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i
      // The smoothing spread the surrounding drop onto the contact points
      // themselves and lowered them off the antagonist (lower molars: 0.02 mm²
      // in contact, technicians 0.61). Each centre's smoothed drop comes back
      // off as a smooth bump (σ CONTACT_HOLD_MM), so the point stays at the
      // clearance. Blending in the raw drop there instead copied the opposing
      // scan's roughness back into the fossae (upper molar 054).
      const ci = nearestC[k]
      const hold = ci >= 0 ? Math.exp(-centreD2[k] / (2 * CONTACT_HOLD_MM * CONTACT_HOLD_MM)) : 0
      const d = smooth[k] - (ci >= 0 ? hold * smooth[centreK[ci]] : 0)
      if (d <= 0.005) continue
      const p = getP(grid, i, j)
      const f = floorOf(k, p)
      const y = f === null ? p[1] - d : Math.max(Math.min(p[1], f), p[1] - d)
      if (y < p[1]) {
        setP(grid, i, j, [p[0], y, p[2]])
        opened++
      }
    }
  }
  if (opened) log.push(`occlusal contacts shaped to ${centres.length} point contact(s)`)
}

const ANTERIOR = new Set<ToothClass>(['upperAnterior', 'lowerAnterior', 'upperCanine', 'lowerCanine'])

/**
 * Front teeth meet the opposing teeth face to face (overbite, overjet), not
 * cusp to fossa: a lower incisor's labial face runs up behind the upper
 * incisors, so lowering it (the bite step) can't clear it. Each vertex still
 * into the opposing teeth moves in toward the axis, horizontally, in 0.05 mm
 * steps until it clears or reaches the wall minimum; the field is spread to
 * neighbours so the face stays fair. On the lab's two lower incisors (case037)
 * the library crowns sat 0.24–0.51 mm into the upper incisors.
 */
function relieveOverlap(grid: CrownGrid, ant: SurfaceIndex, clearance: number, intaglio: SurfaceIndex, minAxialMm: number, log: string[]): void {
  const { nu, nv } = grid
  const move = new Float64Array(nu * nv)
  const j0 = Math.round(nv * 0.25)
  for (let j = j0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const p = getP(grid, i, j)
      if (ant.gapUp(p, 2) >= clearance) continue
      const r = Math.hypot(p[0], p[2])
      if (r < 0.3) continue
      const inn: Vec3 = [-p[0] / r, 0, -p[2] / r]
      let d = 0
      for (let s = 0.05; s <= 1.2 + 1e-9; s += 0.05) {
        const q: Vec3 = [p[0] + inn[0] * s, p[1], p[2] + inn[2] * s]
        if ((intaglio.closest(q, minAxialMm + 1)?.distance ?? Infinity) < minAxialMm) break
        d = s
        if (ant.gapUp(q, 2) >= clearance) break
      }
      move[j * nu + i] = d
    }
  }
  let any = 0
  for (let k = 0; k < move.length; k++) any = Math.max(any, move[k])
  if (any <= 0) return
  // Spread (max with a 3×3 mean, 3 passes): a single vertex pulled in alone dents the face.
  let f = move
  for (let pass = 0; pass < 3; pass++) {
    const g2 = new Float64Array(nu * nv)
    for (let j = j0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        let sum = 0
        let c = 0
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj
          if (jj < j0 || jj >= nv) continue
          for (let di = -1; di <= 1; di++) {
            sum += f[jj * nu + ((i + di + nu) % nu)]
            c++
          }
        }
        g2[j * nu + i] = Math.max(move[j * nu + i], (sum / c) * 0.9)
      }
    }
    f = g2
  }
  for (let j = j0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      let m = f[j * nu + i]
      if (m < 1e-3) continue
      const p = getP(grid, i, j)
      const r = Math.hypot(p[0], p[2])
      if (r < 0.3) continue
      // Never thinner than the wall minimum for the spread part either.
      while (m > 0 && (intaglio.closest([p[0] - (p[0] / r) * m, p[1], p[2] - (p[2] / r) * m], minAxialMm + 1)?.distance ?? Infinity) < minAxialMm) m -= 0.05
      if (m > 0) setP(grid, i, j, [p[0] - (p[0] / r) * m, p[1], p[2] - (p[2] / r) * m])
    }
  }
  log.push(`front-tooth overlap relieved toward the axis, up to ${any.toFixed(2)} mm`)
}

/**
 * Laplacian fairing of what the design changed (the displacement from the
 * placed donor), not of the surface itself. Smoothing positions blurred the
 * donor's grooves, a few grid steps wide, on every crown (lab review:
 * soft, shallow fossae beside the technicians' crisp ones).
 */
function smoothChange(g: CrownGrid, ref: Float64Array, passes: number, lambda: number, fromRow: number): void {
  if ((globalThis as any).process?.env?.SMOOTH_POS) return smoothGrid(g, passes, lambda, fromRow)
  const d = Float64Array.from(g.pts, (v, k) => v - ref[k])
  const pole = g.pole
  const D: CrownGrid = { ...g, pts: d, pole: [0, 0, 0] }
  smoothGrid(D, passes, lambda, fromRow)
  for (let k = 0; k < g.pts.length; k++) g.pts[k] = ref[k] + D.pts[k]
  g.pole = pole
}

/** Pushes the outer surface out until it clears the intaglio by the material minimum. */
export function enforceThickness(
  grid: CrownGrid,
  intaglio: SurfaceIndex,
  centre: Vec3,
  mat: { minAxialMm: number; minOcclusalMm: number; marginThicknessMm: number },
  passes = 4
): void {
  // Vertices comfortably thicker than the maximum requirement can't become
  // thin from these small outward moves; check them once.
  const maxReq = Math.max(mat.minAxialMm, mat.minOcclusalMm)
  let active: Array<[number, number]> = []
  for (let j = 1; j < grid.nv; j++) for (let i = 0; i < grid.nu; i++) active.push([i, j])
  for (let it = 0; it < passes; it++) {
    const s = marginDistances(grid)
    const moves: Array<[number, number, Vec3]> = []
    const axial = new Map<number, number>()
    const keep: Array<[number, number]> = []
    for (const [i, j] of active) {
      const p = getP(grid, i, j)
      const n = gridNormal(grid, i, j)
      const occlusal = n[1] > 0.55 || j > grid.nv * 0.6
      const full = occlusal ? mat.minOcclusalMm : mat.minAxialMm
      // Aim a hair above the minimum so the measured value clears it after
      // the neighbouring vertices settle (re-seating is not exactly 1:1).
      const req = mat.marginThicknessMm + (full + 0.02 - mat.marginThicknessMm) * smoothstep(0, 1.0, s[j * grid.nu + i])
      const sd = intaglio.signedDistance(p, normalize(sub(centre, p)), full + 3)
      if (sd < maxReq + 0.6) keep.push([i, j])
      if (req - sd <= 0.012) continue
      if (j < grid.nv * 0.4 && !occlusal) {
        // Axial wall, judged straight out from the axis: a vertex whose
        // outward ray meets the fitting surface is inside the prep (folded
        // through, or right at the margin where the closest point is the
        // margin edge and re-seating can't clear). Move it out horizontally,
        // so the wall can't fold under the margin; one that is outside but
        // thin moves out by what it lacks.
        const out = normalize([p[0], 0, p[2]])
        const hit = intaglio.raycast(p, out, 0, full + 6)
        const lack = hit ? hit.distance + req : req - (intaglio.closest(p, full + 3)?.distance ?? Infinity)
        if (lack > 0.012) axial.set(j * grid.nu + i, Math.max(axial.get(j * grid.nu + i) ?? 0, lack))
        continue
      }
      // Re-seat the vertex at the required distance along the intaglio's own
      // outward normal at the closest point. The intaglio is ours (built from
      // the grid with known winding), so its normal is trustworthy even where
      // the outer surface has folded through it.
      const c = intaglio.closest(p, full + 6)
      if (!c) continue
      const nq = intaglio.faceNormal(c.faceIndex)
      moves.push([i, j, [c.point[0] + nq[0] * req, c.point[1] + nq[1] * req, c.point[2] + nq[2] * req]])
    }
    active = keep
    // Axial pushes spread to their neighbours (tapering over AXIAL_SPREAD
    // grid steps, rows below the 40 % line): one vertex pushed out alone
    // stood out as a fin (lab case040: 0.85 mm at a single vertex). Moving
    // out horizontally only ever adds thickness.
    if (axial.size) {
      const R = AXIAL_SPREAD
      const spread = new Map<number, number>()
      for (const [k, l] of axial) {
        const i0 = k % grid.nu, j0 = Math.floor(k / grid.nu)
        for (let dj = -R; dj <= R; dj++) {
          const j = j0 + dj
          if (j < 1 || j >= grid.nv * 0.45) continue
          for (let di = -R; di <= R; di++) {
            const w = (1 - Math.hypot(di, dj) / (R + 1)) ** 2
            if (w <= 0) continue
            const kk = j * grid.nu + ((i0 + di + grid.nu) % grid.nu)
            spread.set(kk, Math.max(spread.get(kk) ?? 0, l * w))
          }
        }
      }
      for (const [k, l] of spread) {
        const i = k % grid.nu, j = Math.floor(k / grid.nu)
        const p = getP(grid, i, j)
        const out = normalize([p[0], 0, p[2]])
        moves.push([i, j, [p[0] + out[0] * l, p[1], p[2] + out[2] * l]])
      }
    }
    if (!moves.length) break
    for (const [i, j, p] of moves) setP(grid, i, j, p)
    const pd = intaglio.signedDistance(grid.pole, [0, -1, 0], mat.minOcclusalMm + 3)
    if (pd < mat.minOcclusalMm) grid.pole = [grid.pole[0], grid.pole[1] + (mat.minOcclusalMm - pd), grid.pole[2]]
  }
}

/** Lowest y a vertex may be relieved to: material floor above the intaglio. */
export function occlusalFloor(intaglio: SurfaceIndex, minOcclusalMm: number): (p: Vec3) => number | null {
  return (p) => {
    // Past the edge of the fitting surface's footprint (a ray straight down
    // misses it) the closest point stands in: a missing floor there let the
    // relief cut notches beside clamped neighbours.
    const h = intaglio.raycast([p[0], p[1] + 20, p[2]], [0, -1, 0], 0, 40) ?? intaglio.closest(p, 6)
    if (!h) return null
    // Thickness is measured along the intaglio normal; on a sloped intaglio
    // the vertical gap must be larger to give the same normal thickness.
    const ny = Math.abs(intaglio.faceNormal(h.faceIndex)[1])
    return h.point[1] + (minOcclusalMm + 0.01) / Math.max(0.45, ny)
  }
}

/**
 * Maps template heights (0 at the margin, top at H) onto a crown of height
 * H·sy keeping the top OCCLUSAL_RELIEF_MM at true scale: slope k below, 1
 * above, blended over 1 mm around the junction. Falls back to a uniform
 * scale when the crown is too short to keep its occlusal table whole.
 */
const OCCLUSAL_RELIEF_MM = 2.0
export function heightMap(H: number, sy: number): (y: number) => number {
  const target = H * sy
  const y0 = H - OCCLUSAL_RELIEF_MM
  const k = y0 > 0.5 ? (target - OCCLUSAL_RELIEF_MM) / y0 : NaN
  if (!(k > 0.25) || Math.abs(sy - 1) < 1e-3) return (y) => y * sy
  // f(y) = k·y + (1 − k)·∫₀ʸ smoothstep(y0 − ½, y0 + ½, t) dt
  const S = (y: number): number => {
    if (y <= y0 - 0.5) return 0
    const n = 24
    const top = Math.min(y, y0 + 0.5)
    let acc = 0
    for (let i = 0; i < n; i++) {
      const t = y0 - 0.5 + ((i + 0.5) / n) * (top - (y0 - 0.5))
      acc += smoothstep(y0 - 0.5, y0 + 0.5, t)
    }
    return (acc / n) * (top - (y0 - 0.5)) + Math.max(0, y - (y0 + 0.5))
  }
  return (y) => (y <= 0 ? y * k : k * y + (1 - k) * S(y))
}

/** Designs the outer crown surface for a prepared case. */
export function designOuter(env: DesignEnv, params: DesignParams): OuterResult {
  const steps: string[] = []
  const nu = env.marginRow.length
  const tpl = env.templateOverride ?? buildTemplate(env.toothClass, { nu, nv: env.nv, cuspScale: params.cuspScale, grooveScale: params.grooveScale })
  const g = cloneGrid(tpl.grid)
  const mat = resolvedMaterial(params)

  // 1. Size to the space.
  const tb = gridBounds(g)
  const Wt = tb.max[0] - tb.min[0]
  const Dt = tb.max[2] - tb.min[2]
  const Ht = tb.max[1]
  const marginMD = Math.max(...env.marginRow.map((p) => p[0])) - Math.min(...env.marginRow.map((p) => p[0]))
  const marginBL = Math.max(...env.marginRow.map((p) => p[2])) - Math.min(...env.marginRow.map((p) => p[2]))
  const yLo = 2
  const yHi = Math.max(4, Ht * 0.95)
  let xm = measureSpace(env.mesial, 1, yLo, yHi)
  let xd = measureSpace(env.distal, -1, yLo, yHi)
  // A neighbour farther than a tooth's half-width plus a wide embrasure is
  // across an edentulous span (a bridge abutment's pontic side): no contact.
  const reach = Math.max(Wt, marginMD) / 2 + 3.5
  let mesial = env.mesial
  let distal = env.distal
  if (xm !== null && xm > reach) {
    steps.push(`nearest mesial tooth ${xm.toFixed(1)} mm away — edentulous span, no contact`)
    xm = null
    mesial = null
  }
  if (xd !== null && xd > reach) {
    steps.push(`nearest distal tooth ${xd.toFixed(1)} mm away — edentulous span, no contact`)
    xd = null
    distal = null
  }
  // A space far longer than this tooth's usual length (lab crowns ran at most
  // ~1.2 mm over the usual) is not one the technician fills: the crown keeps
  // its length, touches the mesial neighbour and leaves the distal open
  // (lab case040: 11.8 mm space, technician's crown 10.0 with a 2.2 mm gap).
  if (xm !== null && xd !== null && xm + xd > marginMD + (mdOver(env) ?? 1.2) + 1.3) {
    steps.push(`space ${(xm + xd).toFixed(1)} mm is far longer than this tooth — distal left open`)
    xd = null
    distal = null
  }
  let W: number
  let xc: number
  if (xm !== null && xd !== null) {
    W = xm + xd
    xc = (xm - xd) / 2
    steps.push(`mesiodistal space ${W.toFixed(2)} mm between neighbours`)
  } else if (xm !== null || xd !== null) {
    // One neighbour: the crown takes its usual length over the margin, and
    // reaches the neighbour only when that is close enough to touch.
    const known = (xm ?? xd) as number
    const sign = xm !== null ? 1 : -1
    const usual = marginMD + (mdOver(env) ?? 1.2)
    if (known <= usual / 2 + 0.6) {
      W = known + usual / 2
      xc = sign * (known - W / 2)
      steps.push(`one neighbour only — width ${W.toFixed(2)} mm, in contact with it`)
    } else {
      W = usual
      xc = 0
      steps.push(`one neighbour only, ${known.toFixed(1)} mm away — usual width ${W.toFixed(2)} mm`)
      // Too far to touch at its usual length: the contact step mustn't then
      // stretch the crown to it (lab case064: 1.3 mm longer than the
      // technician's, who left a 0.8 mm gap).
      if (xm !== null) mesial = null
      else distal = null
    }
  } else {
    W = marginMD + (mdOver(env) ?? 1.2)
    xc = 0
    steps.push(`no neighbours found — width ${W.toFixed(2)} mm from margin`)
  }
  W += 0.15 // a hair wide, so the contact step trims into a definite contact
  const sx = W / Wt
  const blOver = blOverOf(env)
  const D = blOver !== undefined ? marginBL + blOver : Math.max(Dt * sx, marginBL + 1.4)
  const sz = D / Dt
  const rot = (params.rotationDeg * Math.PI) / 180
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  const place = (p: Vec3, sy: number): Vec3 => {
    const x = p[0] * cr + p[2] * sr
    const z = -p[0] * sr + p[2] * cr
    return [x * sx + xc + params.mdShiftMm, p[1] * sy, z * sz + params.blShiftMm]
  }
  // Height: cusp tips to the antagonist.
  let sy = (sx + sz) / 2
  // Two antagonist readings: the median tip (a cap when the neighbours set
  // the height) and the most limiting tip (the height itself when there is
  // no neighbour to level with — the median let two of five tips push in,
  // and the bite step carved them into pits on crowns 0.6–0.9 mm too tall;
  // as a cap it pulled first molars down under a single opposing cusp).
  let syLimit = sy
  let biteProbes = 0
  let ridgeSides = 0
  if (env.antagonist) {
    const ratios: number[] = []
    for (const tip of tpl.cuspTips) {
      const p = place(getP(tpl.grid, tip.i, tip.j), 1)
      const h = env.antagonist.raycast([p[0], -2, p[2]], [0, 1, 0], 0, 30)
      if (h) ratios.push((h.point[1] - params.occlusalClearanceMm - 0.1) / p[1])
    }
    const sorted = ratios.slice().sort((a, b) => a - b)
    const r = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN
    if (Number.isFinite(r)) sy = clamp(r, sx * 0.55, sx * 1.5)
    if (sorted.length) syLimit = clamp(sorted[0], sx * 0.55, sx * 1.5)
    biteProbes = ratios.length
    steps.push(`vertical scale ${sy.toFixed(2)} from antagonist (${ratios.length} cusp probes; first to touch ${syLimit.toFixed(2)})`)
  }
  // Technicians level the marginal ridges with the neighbours' (measured on the
  // lab's crowns: within ~0.3 mm), so the neighbours set the height; the
  // antagonist only caps it (cusps reaching up into its fossae made crowns
  // 1–3 mm too tall).
  {
    const ridgeOf = (sign: 1 | -1): number => {
      let best = -Infinity
      let edge = -Infinity
      for (let j = 0; j < g.nv; j++) for (let i = 0; i < nu; i++) edge = Math.max(edge, sign * place(getP(tpl.grid, i, j), 1)[0])
      for (let j = 0; j < g.nv; j++) {
        for (let i = 0; i < nu; i++) {
          const p = place(getP(tpl.grid, i, j), 1)
          if (sign * p[0] > edge - 1.2) best = Math.max(best, p[1])
        }
      }
      return best
    }
    const ratios: number[] = []
    for (const [n, sign, x] of [[mesial, 1, xm], [distal, -1, xd]] as const) {
      // Only a neighbour the crown will touch: one across a gap says nothing about this tooth.
      if (x === null || x > W / 2 + sign * xc + 0.6) continue
      // The lab's technicians set a lower molar's mesial marginal ridge a
      // little above the neighbour's: first molars +0.23 mm (−0.58…+1.03,
      // 12 crowns), second molars +0.43 (−0.22…+0.82, 3) — curve of Spee.
      const ridge = neighbourRidge(n, sign, x)
      const target = ridge === null ? null : ridge + (sign > 0 && env.toothClass === 'lowerMolar' ? (secondMolar(env) ? 0.45 : 0.25) : 0)
      const own = ridgeOf(sign)
      // A neighbour ridge far below this tooth's own (a short or broken tooth) says little.
      if (target !== null && own > 0.5 && target > own * sx * 0.45) ratios.push(target / own)
    }
    ridgeSides = ratios.length
    if (ratios.length) {
      const r = ratios.reduce((a, b) => a + b, 0) / ratios.length
      const capped = Math.min(clamp(r, sx * 0.55, sx * 1.5), env.antagonist ? sy : Infinity)
      steps.push(`vertical scale ${capped.toFixed(2)} from the neighbours' marginal ridges (${ratios.length} side${ratios.length > 1 ? 's' : ''})`)
      sy = capped
    } else if (env.antagonist && syLimit <= sx) {
      steps.push(`vertical scale ${syLimit.toFixed(2)} — the first cusp to touch the antagonist (no neighbour ridge to level with)`)
      sy = syLimit
    } else if (sy > sx) {
      // No usable neighbour: keep the tooth's own proportions rather than
      // stretching the cusps up to a distant antagonist.
      steps.push(`vertical scale ${sx.toFixed(2)} — tooth proportions (no neighbour ridge to level with)`)
      sy = sx
    }
  }
  // The height change goes into the walls, not the occlusal anatomy: a
  // uniform vertical scale (0.73–0.78 on short preps) shrank cusp height and
  // fissure depth with it; a technician keeps the occlusal table and
  // shortens or lengthens the crown below it.
  const H = Math.max(tpl.grid.pole[1], ...Array.from({ length: g.nv * nu }, (_, k) => tpl.grid.pts[3 * k + 1]))
  const lift = heightMap(H, sy)
  const placed = (p: Vec3): Vec3 => {
    const q = place(p, 1)
    return [q[0], lift(q[1]), q[2]]
  }
  for (let j = 0; j < g.nv; j++) for (let i = 0; i < nu; i++) setP(g, i, j, placed(getP(tpl.grid, i, j)))
  g.pole = placed(tpl.grid.pole)
  env.onStage?.('placed', g)
  // The donor as placed: the fairing passes below smooth what the design
  // changed, not the donor's own grooves and ridges.
  const donorRef = Float64Array.from(g.pts)
  if (params.heightOffsetMm) {
    for (let j = 0; j < g.nv; j++) {
      const w = smoothstep(0.3, 0.7, j / g.nv) * params.heightOffsetMm
      for (let i = 0; i < nu; i++) {
        const p = getP(g, i, j)
        setP(g, i, j, [p[0], p[1] + w, p[2]])
      }
    }
    g.pole = [g.pole[0], g.pole[1] + params.heightOffsetMm, g.pole[2]]
  }

  // 2. Emergence profile: from the margin up to the height of contour.
  // Library teeth carry their own cervical neck (narrowing toward the CEJ);
  // shifting it onto the margin leaves a ring-shaped crease. Instead each
  // meridian is rebuilt below its widest point as a smooth convex curve
  // leaving the margin and joining the template there with matching slope.
  let mcx = 0
  let mcz = 0
  for (const m of env.marginRow) {
    mcx += m[0] / nu
    mcz += m[2] / nu
  }
  const jMax = Math.max(3, Math.floor(g.nv * 0.55))
  // How far out the wall leaves the margin (the start tangent's share of the
  // outward run to the height of contour). At 0.9 the walls rose straight:
  // 12–18° from the axis against the technicians' 17–24°, 0.22–0.39 mm out
  // 1 mm above the margin against 0.36–0.52. At 2.2 lower molars and both
  // premolar classes came to 17–25° and 0.30–0.49 mm, closer to the
  // technicians' crowns and no new failures; upper molars lost a passing
  // donor on a tall prep (case012) and their match on the technician's margin,
  // so they keep 0.9.
  const er = env.toothClass === 'upperMolar' ? Number((globalThis as any).process?.env?.EMERG_UM ?? 0.9) : 2.2
  for (let i = 0; i < nu; i++) {
    const m = env.marginRow[i]
    let jc = 2
    let rBest = -Infinity
    for (let j = 2; j <= jMax; j++) {
      const p = getP(g, i, j)
      const r = Math.hypot(p[0] - mcx, p[2] - mcz)
      if (r > rBest) {
        rBest = r
        jc = j
      }
    }
    const P1 = getP(g, i, jc)
    const a = getP(g, i, jc - 1)
    const b = getP(g, i, jc + 1)
    // Tangents in "per unit s" (s = j / jc): the template's at the join,
    // and a mostly-occlusal start at the margin (a straight-ish emergence).
    const T1: Vec3 = [((b[0] - a[0]) / 2) * jc, ((b[1] - a[1]) / 2) * jc, ((b[2] - a[2]) / 2) * jc]
    const chord: Vec3 = [P1[0] - m[0], P1[1] - m[1], P1[2] - m[2]]
    const T0: Vec3 = [chord[0] * er, Math.max(chord[1], 0.5) * 1.1, chord[2] * er]
    for (let j = 0; j < jc; j++) {
      const t = j / jc
      const t2 = t * t
      const t3 = t2 * t
      const h00 = 2 * t3 - 3 * t2 + 1
      const h10 = t3 - 2 * t2 + t
      const h01 = -2 * t3 + 3 * t2
      const h11 = t3 - t2
      setP(g, i, j, [
        h00 * m[0] + h10 * T0[0] + h01 * P1[0] + h11 * T1[0],
        h00 * m[1] + h10 * T0[1] + h01 * P1[1] + h11 * T1[1],
        h00 * m[2] + h10 * T0[2] + h01 * P1[2] + h11 * T1[2]
      ])
    }
  }
  smoothChange(g, donorRef, 3, 0.3, 1)
  steps.push('emergence profile from the margin to the height of contour')
  env.onStage?.('emergence', g)

  // Bulges (buccal/lingual contour).
  if (params.buccalBulgeMm || params.lingualBulgeMm) {
    for (let j = 1; j < g.nv; j++) {
      const t = j / g.nv
      const w = Math.sin(Math.PI * clamp(t / 0.5, 0, 1))
      for (let i = 0; i < nu; i++) {
        const th = thetaOf(g, i)
        const amt = Math.max(0, Math.cos(th)) ** 2 * params.buccalBulgeMm + Math.max(0, -Math.cos(th)) ** 2 * params.lingualBulgeMm
        if (!amt) continue
        const p = getP(g, i, j)
        const n = gridNormal(g, i, j)
        setP(g, i, j, [p[0] + n[0] * amt * w, p[1] + n[1] * amt * w, p[2] + n[2] * amt * w])
      }
    }
  }

  // 3. Sculpt ops.
  for (const op of params.sculpt) {
    const c = op.at ?? (op.region ? regionCentre(op.region, g, tpl.cuspTips) : null)
    if (c) applySculpt(g, c, op.amountMm, op.radiusMm)
  }
  if (params.sculpt.length) steps.push(`${params.sculpt.length} sculpt edit(s) applied`)

  // 4. Contacts.
  const openContacts: DesignMeasures['openContacts'] = []
  const wall = { intaglio: env.intaglioIndex, minAxialMm: mat.minAxialMm, minOcclusalMm: mat.minOcclusalMm }
  if (mesial) {
    const r = enforceContact(g, mesial, 1, params.contactMesialMm, steps, wall)
    if (r.gap !== null && r.gap > 0.05) openContacts.push({ side: 'mesial', gapMm: r.gap })
  }
  if (distal) {
    const r = enforceContact(g, distal, -1, params.contactDistalMm, steps, wall)
    if (r.gap !== null && r.gap > 0.05) openContacts.push({ side: 'distal', gapMm: r.gap })
  }
  steps.push('proximal contacts set')
  env.onStage?.('contacts', g)

  // 5. Occlusion.
  if (env.antagonist) {
    enforceOcclusion(g, env.antagonist, params.occlusalClearanceMm, tpl.cuspTips, params.occlusalContacts, steps, occlusalFloor(env.intaglioIndex, mat.minOcclusalMm))
    steps.push(`occlusion relieved to ${params.occlusalClearanceMm.toFixed(2)} mm`)
  }
  env.onStage?.('occlusion', g)

  // 6. Thickness (wins), then a light fairing pass and a final check of each.
  const centre: Vec3 = [0, env.intaglio.pole[1] * 0.45, 0]
  const bite = env.antagonist ? { antagonist: env.antagonist, clearanceMm: params.occlusalClearanceMm } : undefined
  raiseUnderReduced(g, env.intaglioIndex, centre, mat.minOcclusalMm, mat.minAxialMm, steps, bite)
  enforceThickness(g, env.intaglioIndex, centre, mat)
  smoothChange(g, donorRef, 2, 0.25, 2)
  env.onStage?.('thickness1', g)
  if (mesial) enforceContact(g, mesial, 1, params.contactMesialMm, [], wall)
  if (distal) enforceContact(g, distal, -1, params.contactDistalMm, [], wall)
  if (env.antagonist) enforceOcclusion(g, env.antagonist, params.occlusalClearanceMm, tpl.cuspTips, false, [], occlusalFloor(env.intaglioIndex, mat.minOcclusalMm))
  env.onStage?.('final-occlusion', g)
  if (env.antagonist && ANTERIOR.has(env.toothClass)) relieveOverlap(g, env.antagonist, params.occlusalClearanceMm, env.intaglioIndex, mat.minAxialMm, steps)
  raiseUnderReduced(g, env.intaglioIndex, centre, mat.minOcclusalMm, mat.minAxialMm, undefined, bite)
  env.onStage?.('final-raise', g)
  enforceThickness(g, env.intaglioIndex, centre, mat, 14)
  env.onStage?.('final-thickness', g)
  steps.push(`minimum thickness enforced (${mat.minAxialMm} axial / ${mat.minOcclusalMm} occlusal mm)`)
  if (env.antagonist) {
    shapeContacts(g, env.antagonist, params.occlusalClearanceMm, occlusalFloor(env.intaglioIndex, mat.minOcclusalMm), steps)
    env.onStage?.('final-shape', g)
    // What the smoothed floor let dip under the material minimum comes back
    // up as one smooth lift; re-seated vertex by vertex it took the prep's
    // shape (dents on 054's mesial fossa).
    raiseUnderReduced(g, env.intaglioIndex, centre, mat.minOcclusalMm, mat.minAxialMm, undefined, bite)
    // Thickness wins over the contact shape: the floor above is vertical, the
    // check runs toward the centre, and on cusp slopes the two differ
    // (upper molars 054, 085 came out under the occlusal minimum).
    enforceThickness(g, env.intaglioIndex, centre, mat, 4)
    // That last outward push can reach the antagonist on a tight prep (lower
    // premolar 074: 0.01 mm into it); relieve what it pushed in, above the floor.
    enforceOcclusion(g, env.antagonist, params.occlusalClearanceMm, tpl.cuspTips, false, [], occlusalFloor(env.intaglioIndex, mat.minOcclusalMm))
    // Thickness has the last word: the floor above is vertical and slopes can
    // still come out thin; where the two truly conflict the prep is
    // under-reduced and the bite check reports it.
    enforceThickness(g, env.intaglioIndex, centre, mat, 4)
  }
  // Outward only, after every thinning step: widens each touching contact.
  let widened = 0
  if (mesial) widened = Math.max(widened, widenContact(g, mesial, 1, params.contactMesialMm, env.toothClass))
  if (distal) widened = Math.max(widened, widenContact(g, distal, -1, params.contactDistalMm, env.toothClass))
  if (widened > 0) steps.push(`proximal contacts widened to a patch (up to ${widened.toFixed(2)} mm)`)
  env.onStage?.('final', g)

  const b = gridBounds(g)
  return {
    grid: g,
    cuspTips: tpl.cuspTips,
    neighbours: { mesial, distal },
    measures: {
      spaceMesialMm: xm,
      spaceDistalMm: xd,
      mdWidthMm: b.max[0] - b.min[0],
      blWidthMm: b.max[2] - b.min[2],
      heightMm: b.max[1] - b.min[1],
      verticalScale: sy,
      biteProbes,
      ridgeSides,
      steps,
      openContacts
    }
  }
}
