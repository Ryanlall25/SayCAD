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
  occlusalClearanceMm: 0.05,
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
 * Bucco-lingual width beyond the margin's (mm), measured on the lab's own
 * crowns: lower first molars 0.55 (0.11–1.05, 9 crowns). Classes not yet
 * measured keep the earlier rule (at least 1.4 mm).
 */
const BL_OVER_MARGIN: Partial<Record<ToothClass, number>> = { lowerMolar: 0.55 }
/**
 * Mesiodistal length beyond the margin's (mm), same crowns: lower first
 * molars 1.6 (0.78–2.82, 9 crowns), lower second molars 0.6 (0.21–0.93,
 * 5 crowns) — a second molar's crown barely overhangs its margin.
 */
const MD_OVER_MARGIN: Partial<Record<ToothClass, number>> = { lowerMolar: 1.6 }
const MD_OVER_SECOND_MOLAR: Partial<Record<ToothClass, number>> = { lowerMolar: 0.6 }
const BL_OVER_SECOND_MOLAR: Partial<Record<ToothClass, number>> = { lowerMolar: 0.65 }
const secondMolar = (env: DesignEnv): boolean => env.toothNumber !== undefined && toothSide(env.toothNumber).pos === 7
const mdOver = (env: DesignEnv): number | undefined => (secondMolar(env) ? MD_OVER_SECOND_MOLAR[env.toothClass] : undefined) ?? MD_OVER_MARGIN[env.toothClass]
const blOverOf = (env: DesignEnv): number | undefined => (secondMolar(env) ? BL_OVER_SECOND_MOLAR[env.toothClass] : undefined) ?? BL_OVER_MARGIN[env.toothClass]

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
          const dp = wall.intaglio.closest(p, min + 1)?.distance ?? Infinity
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
            const dp = wall.intaglio.closest(p, min + 1)?.distance ?? Infinity
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

/** Lowers anything closer than `clearance` to the antagonist; optionally first
 *  raises cusp tips into contact. */
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
  const j0 = Math.round(grid.nv * 0.3)
  const floors = new Map<number, number | null>()
  const floorOf = (k: number, p: Vec3): number | null => {
    if (!floorY) return null
    if (!floors.has(k)) floors.set(k, floorY(p))
    return floors.get(k)!
  }
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
    const blurred = smoothField(grid, deficit, 3)
    for (let j = j0; j < grid.nv; j++) {
      for (let i = 0; i < grid.nu; i++) {
        const k = j * grid.nu + i
        const d = Math.max(deficit[k], blurred[k] * 1.5) * smoothstep(j0, j0 + 4, j)
        if (d <= 0) continue
        const p = getP(grid, i, j)
        // Never relieve below the material floor: thickness outranks occlusion,
        // and the resulting high spot is reported by the occlusion critic.
        const f = floorOf(k, p)
        const y = f === null ? p[1] - d : Math.max(Math.min(p[1], f), p[1] - d)
        setP(grid, i, j, [p[0], y, p[2]])
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
        if (lack > 0.012) moves.push([i, j, [p[0] + out[0] * lack, p[1], p[2] + out[2] * lack]])
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
    if (!moves.length) break
    for (const [i, j, p] of moves) setP(grid, i, j, p)
    const pd = intaglio.signedDistance(grid.pole, [0, -1, 0], mat.minOcclusalMm + 3)
    if (pd < mat.minOcclusalMm) grid.pole = [grid.pole[0], grid.pole[1] + (mat.minOcclusalMm - pd), grid.pole[2]]
  }
}

/** Lowest y a vertex may be relieved to: material floor above the intaglio. */
export function occlusalFloor(intaglio: SurfaceIndex, minOcclusalMm: number): (p: Vec3) => number | null {
  return (p) => {
    const h = intaglio.raycast([p[0], p[1] + 20, p[2]], [0, -1, 0], 0, 40)
    if (!h) return null
    // Thickness is measured along the intaglio normal; on a sloped intaglio
    // the vertical gap must be larger to give the same normal thickness.
    const ny = Math.abs(intaglio.faceNormal(h.faceIndex)[1])
    return h.point[1] + (minOcclusalMm + 0.01) / Math.max(0.45, ny)
  }
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
      // Curve of Spee: a lower second molar's mesial ridge sits ~0.7 mm over
      // the first molar's (lab crowns: +0.7, +0.8); first molars level with it.
      const ridge = neighbourRidge(n, sign, x)
      const target = ridge === null ? null : ridge + (secondMolar(env) && sign > 0 && env.toothClass === 'lowerMolar' ? 0.7 : 0)
      const own = ridgeOf(sign)
      // A neighbour ridge far below this tooth's own (a short or broken tooth) says little.
      if (target !== null && own > 0.5 && target > own * sx * 0.45) ratios.push(target / own)
    }
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
  for (let j = 0; j < g.nv; j++) for (let i = 0; i < nu; i++) setP(g, i, j, place(getP(tpl.grid, i, j), sy))
  g.pole = place(tpl.grid.pole, sy)
  env.onStage?.('placed', g)
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
    const T0: Vec3 = [chord[0] * 0.9, Math.max(chord[1], 0.5) * 1.1, chord[2] * 0.9]
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
  smoothGrid(g, 3, 0.3, 1)
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
  enforceThickness(g, env.intaglioIndex, centre, mat)
  smoothGrid(g, 2, 0.25, 2)
  env.onStage?.('thickness1', g)
  if (mesial) enforceContact(g, mesial, 1, params.contactMesialMm, [], wall)
  if (distal) enforceContact(g, distal, -1, params.contactDistalMm, [], wall)
  if (env.antagonist) enforceOcclusion(g, env.antagonist, params.occlusalClearanceMm, tpl.cuspTips, false, [], occlusalFloor(env.intaglioIndex, mat.minOcclusalMm))
  enforceThickness(g, env.intaglioIndex, centre, mat, 14)
  steps.push(`minimum thickness enforced (${mat.minAxialMm} axial / ${mat.minOcclusalMm} occlusal mm)`)
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
      steps,
      openContacts
    }
  }
}
