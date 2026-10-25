import { clamp, smoothstep, type Vec3 } from './geom'
import { createGrid, setP, type CrownGrid } from './grid'
import { arcLengths, resample, smoothLine, type ProfilePoint } from './slice'

/**
 * Parametric anatomical crown templates, built directly on the crown grid.
 *
 * This is the anatomy prior the engine starts from before any of the lab's
 * own cases have been learned (see ssm.ts). It is a deliberately explicit
 * model of what a technician waxes: an axial outline whose buccal height of
 * contour sits in the cervical third and lingual in the middle third,
 * proximal contacts in the occlusal third, then an occlusal table of cusps
 * (smooth cones, ~30° inclines), marginal ridges and cut grooves. Every
 * number is a named, documented parameter so it can be tuned from the lab's
 * cases — and so the AI layer can reason about it ("more pronounced cusps"
 * = cuspScale).
 *
 * Coordinates: tooth-local (x mesial, y occlusal, z buccal), mm, cervical
 * outline at y = 0. Dimensions are typical crown averages (Wheeler's), not
 * patient data; the fitter rescales to the case.
 */

export type ToothClass =
  | 'lowerMolar'
  | 'upperMolar'
  | 'lowerPremolar'
  | 'upperPremolar'
  | 'upperAnterior'
  | 'lowerAnterior'
  | 'upperCanine'
  | 'lowerCanine'

export interface CuspSpec {
  name: string
  /** Normalized occlusal position: u = x / half-MD, w = z / half-BL (buccal +). */
  u: number
  w: number
  /** Height above the central-fossa level, mm. */
  height: number
  /** Base radius of the cusp cone, mm. */
  radius: number
}

export interface AnatomySpec {
  cls: ToothClass
  /** Crown dimensions at the height of contour, mm. */
  mdWidth: number
  blWidth: number
  /** Cervical outline size relative to the contour (0–1). */
  cervicalRatioMD: number
  cervicalRatioBL: number
  /** Heights (mm above cervical): proximal contact, buccal/lingual heights of contour. */
  contactHeight: number
  buccalContourHeight: number
  lingualContourHeight: number
  /** Height where the occlusal table begins, mm. */
  occlusalEdge: number
  /** Occlusal outline relative to the contour outline. */
  occlusalRatioMD: number
  occlusalRatioBL: number
  /** Central fossa level below the occlusal edge, mm. */
  fossaDepth: number
  cusps: CuspSpec[]
  marginalRidgeHeight: number
  grooveDepth: number
  squareness: number
}

export function toothClassOf(n: number): ToothClass {
  const upper = n <= 16
  const fromMid = n <= 8 ? 8 - n : n <= 16 ? n - 9 : n <= 24 ? 24 - n : n - 25
  if (fromMid >= 5) return upper ? 'upperMolar' : 'lowerMolar'
  if (fromMid >= 3) return upper ? 'upperPremolar' : 'lowerPremolar'
  if (fromMid === 2) return upper ? 'upperCanine' : 'lowerCanine'
  return upper ? 'upperAnterior' : 'lowerAnterior'
}

export function anatomySpec(cls: ToothClass): AnatomySpec {
  switch (cls) {
    case 'lowerMolar':
      return {
        cls, mdWidth: 11.0, blWidth: 10.5, cervicalRatioMD: 0.8, cervicalRatioBL: 0.84,
        contactHeight: 5.0, buccalContourHeight: 2.0, lingualContourHeight: 3.6, occlusalEdge: 5.6,
        occlusalRatioMD: 0.93, occlusalRatioBL: 0.82, fossaDepth: 0.7,
        cusps: [
          { name: 'mesiobuccal', u: 0.45, w: 0.5, height: 1.9, radius: 3.4 },
          { name: 'distobuccal', u: -0.12, w: 0.56, height: 1.8, radius: 3.2 },
          { name: 'distal', u: -0.66, w: 0.3, height: 1.4, radius: 2.6 },
          { name: 'mesiolingual', u: 0.42, w: -0.5, height: 2.2, radius: 3.4 },
          { name: 'distolingual', u: -0.38, w: -0.52, height: 2.0, radius: 3.2 }
        ],
        marginalRidgeHeight: 1.25, grooveDepth: 0.45, squareness: 3.0
      }
    case 'upperMolar':
      return {
        cls, mdWidth: 10.0, blWidth: 11.0, cervicalRatioMD: 0.8, cervicalRatioBL: 0.85,
        contactHeight: 5.0, buccalContourHeight: 2.0, lingualContourHeight: 3.6, occlusalEdge: 5.6,
        occlusalRatioMD: 0.93, occlusalRatioBL: 0.8, fossaDepth: 0.7,
        cusps: [
          { name: 'mesiobuccal', u: 0.42, w: 0.52, height: 2.0, radius: 3.3 },
          { name: 'distobuccal', u: -0.45, w: 0.52, height: 1.8, radius: 3.0 },
          { name: 'mesiolingual', u: 0.3, w: -0.5, height: 2.4, radius: 3.8 },
          { name: 'distolingual', u: -0.55, w: -0.55, height: 1.4, radius: 2.6 }
        ],
        marginalRidgeHeight: 1.25, grooveDepth: 0.45, squareness: 3.0
      }
    case 'lowerPremolar':
      return {
        cls, mdWidth: 7.0, blWidth: 8.0, cervicalRatioMD: 0.74, cervicalRatioBL: 0.85,
        contactHeight: 5.5, buccalContourHeight: 2.0, lingualContourHeight: 3.6, occlusalEdge: 6.0,
        occlusalRatioMD: 0.9, occlusalRatioBL: 0.78, fossaDepth: 0.6,
        cusps: [
          { name: 'buccal', u: 0.05, w: 0.42, height: 2.4, radius: 3.2 },
          { name: 'lingual', u: 0.0, w: -0.55, height: 1.5, radius: 2.6 }
        ],
        marginalRidgeHeight: 1.2, grooveDepth: 0.4, squareness: 2.4
      }
    case 'upperPremolar':
      return {
        cls, mdWidth: 7.0, blWidth: 9.0, cervicalRatioMD: 0.72, cervicalRatioBL: 0.86,
        contactHeight: 5.5, buccalContourHeight: 2.0, lingualContourHeight: 3.6, occlusalEdge: 6.0,
        occlusalRatioMD: 0.9, occlusalRatioBL: 0.78, fossaDepth: 0.6,
        cusps: [
          { name: 'buccal', u: 0.05, w: 0.48, height: 2.3, radius: 3.2 },
          { name: 'lingual', u: 0.02, w: -0.5, height: 2.0, radius: 3.0 }
        ],
        marginalRidgeHeight: 1.2, grooveDepth: 0.4, squareness: 2.4
      }
    case 'upperCanine':
    case 'lowerCanine':
      return {
        cls, mdWidth: cls === 'upperCanine' ? 7.5 : 7.0, blWidth: cls === 'upperCanine' ? 7.8 : 7.5, cervicalRatioMD: 0.72, cervicalRatioBL: 0.9,
        contactHeight: 6.0, buccalContourHeight: 2.0, lingualContourHeight: 2.5, occlusalEdge: 7.0,
        occlusalRatioMD: 0.78, occlusalRatioBL: 0.45, fossaDepth: -0.5,
        cusps: [{ name: 'cusp tip', u: 0.05, w: 0.25, height: 2.6, radius: 3.4 }],
        marginalRidgeHeight: 0.6, grooveDepth: 0.0, squareness: 2.2
      }
    case 'upperAnterior':
    case 'lowerAnterior':
      return {
        cls, mdWidth: cls === 'upperAnterior' ? 8.5 : 5.5, blWidth: cls === 'upperAnterior' ? 7.0 : 6.0, cervicalRatioMD: 0.75, cervicalRatioBL: 0.9,
        contactHeight: 7.5, buccalContourHeight: 1.5, lingualContourHeight: 1.5, occlusalEdge: 8.6,
        occlusalRatioMD: 0.95, occlusalRatioBL: 0.3, fossaDepth: -0.4,
        cusps: [{ name: 'incisal edge', u: 0, w: 0.3, height: 1.4, radius: 6.5 }],
        marginalRidgeHeight: 0.7, grooveDepth: 0.0, squareness: 2.6
      }
  }
}

export interface TemplateOptions {
  nu?: number
  nv?: number
  /** Scales every cusp's height (1 = textbook). */
  cuspScale?: number
  /** Scales groove depth (0 = smooth occlusal table). */
  grooveScale?: number
}

export interface Template {
  spec: AnatomySpec
  grid: CrownGrid
  /** Grid address (meridian, row) of each cusp tip, for sculpting by name. */
  cuspTips: Array<{ name: string; i: number; j: number }>
}

const superR = (dx: number, dz: number, a: number, b: number, p: number): number =>
  Math.pow(Math.abs(dx) ** p / a ** p + Math.abs(dz) ** p / b ** p, -1 / p)

function smax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.max(a, b) + (h * h * k) / 4
}

/** Half-widths of the axial outline at height y (mm). */
function outlineAt(s: AnatomySpec, y: number): { a: number; bb: number; bl: number } {
  const A = s.mdWidth / 2
  const B = s.blWidth / 2
  const prof = (cerv: number, peakY: number, edgeRatio: number): number => {
    if (y <= peakY) return cerv + (1 - cerv) * Math.sin((Math.PI / 2) * clamp(y / peakY, 0, 1)) ** 0.85
    const t = clamp((y - peakY) / Math.max(0.1, s.occlusalEdge - peakY), 0, 1)
    return 1 - (1 - edgeRatio) * t * t
  }
  return {
    a: A * prof(s.cervicalRatioMD, s.contactHeight, s.occlusalRatioMD),
    bb: B * prof(s.cervicalRatioBL, s.buccalContourHeight, s.occlusalRatioBL),
    bl: B * prof(s.cervicalRatioBL, s.lingualContourHeight, s.occlusalRatioBL)
  }
}

/** Occlusal table height at local (x, z). */
function occlusalHeight(s: AnatomySpec, x: number, z: number, o: Required<Pick<TemplateOptions, 'cuspScale' | 'grooveScale'>>): number {
  const a = (s.mdWidth / 2) * s.occlusalRatioMD
  const b = (s.blWidth / 2) * s.occlusalRatioBL
  const u = x / a
  const w = z / b
  const base = s.occlusalEdge - s.fossaDepth
  let field = 0
  for (const c of s.cusps) {
    const d = Math.hypot(x - c.u * a, z - c.w * b)
    const cone = c.height * o.cuspScale * (1 - smoothstep(0, c.radius, d))
    field = smax(field, cone, 0.5)
  }
  // Marginal ridges along the mesial and distal edges of the table.
  const ridgeW = Math.exp(-((Math.abs(u) - 0.86) ** 2) / (2 * 0.12 ** 2)) * smoothstep(0.85, 0.4, Math.abs(w))
  field = smax(field, s.marginalRidgeHeight * ridgeW, 0.4)
  // Grooves: central (mesiodistal) and the buccal/lingual developmental grooves.
  if (s.grooveDepth > 0 && o.grooveScale > 0) {
    const g = s.grooveDepth * o.grooveScale
    const central = Math.exp(-((z - 0.04 * b * Math.sin(u * 4)) ** 2) / (2 * 0.28 ** 2)) * smoothstep(0.95, 0.6, Math.abs(u))
    let dev = 0
    if (s.cusps.length >= 4) {
      dev += Math.exp(-((x - 0.15 * a) ** 2) / (2 * 0.25 ** 2)) * smoothstep(0, 0.25, w) * smoothstep(0.95, 0.5, w)
      dev += Math.exp(-((x + 0.02 * a) ** 2) / (2 * 0.25 ** 2)) * smoothstep(0, -0.25, w) * smoothstep(-0.95, -0.5, w)
    }
    field -= g * Math.max(central, dev)
  }
  return base + field
}

/** Builds a template crown grid for a tooth class. */
export function buildTemplate(cls: ToothClass, opts: TemplateOptions = {}): Template {
  const nu = opts.nu ?? 128
  const nv = opts.nv ?? 56
  const o = { cuspScale: opts.cuspScale ?? 1, grooveScale: opts.grooveScale ?? 1 }
  const s = anatomySpec(cls)
  const grid = createGrid(nu, nv)
  const pole: Vec3 = [0, occlusalHeight(s, 0, 0, o), 0]
  const AXIAL_STEPS = 48
  const OCC_STEPS = 56
  for (let i = 0; i < nu; i++) {
    const th = (2 * Math.PI * i) / nu
    const dx = Math.sin(th)
    const dz = Math.cos(th)
    const line: ProfilePoint[] = []
    // Axial wall, cervical → occlusal edge.
    for (let k = 0; k <= AXIAL_STEPS; k++) {
      const y = (s.occlusalEdge * k) / AXIAL_STEPS
      const ol = outlineAt(s, y)
      const r = superR(dx, dz, ol.a, dz >= 0 ? ol.bb : ol.bl, s.squareness)
      line.push({ r, h: y })
    }
    // Occlusal table, edge → centre.
    const olE = outlineAt(s, s.occlusalEdge)
    const rEdge = superR(dx, dz, olE.a, dz >= 0 ? olE.bb : olE.bl, s.squareness)
    for (let k = 1; k <= OCC_STEPS; k++) {
      const rho = 1 - k / OCC_STEPS
      const r = rEdge * rho
      line.push({ r, h: occlusalHeight(s, r * dx, r * dz, o) })
    }
    // Round the line angle between wall and table, then sample by arc length.
    const dense = smoothLine(resample(line, 0.05), 3)
    dense[0] = line[0]
    dense[dense.length - 1] = { r: 0, h: pole[1] }
    const sl = arcLengths(dense)
    const total = sl[sl.length - 1]
    let k = 0
    for (let j = 0; j < nv; j++) {
      const target = (total * j) / nv
      while (k < dense.length - 2 && sl[k + 1] < target) k++
      const t = (target - sl[k]) / Math.max(1e-9, sl[k + 1] - sl[k])
      const r = dense[k].r + (dense[k + 1].r - dense[k].r) * t
      const h = dense[k].h + (dense[k + 1].h - dense[k].h) * t
      setP(grid, i, j, [r * dx, h, r * dz])
    }
  }
  grid.pole = pole
  // Locate cusp tips on the grid: highest vertex near each cusp's (x, z).
  const a = (s.mdWidth / 2) * s.occlusalRatioMD
  const b = (s.blWidth / 2) * s.occlusalRatioBL
  const cuspTips = s.cusps.map((c) => {
    let best = { i: 0, j: 0, score: -Infinity }
    for (let j = Math.floor(nv * 0.3); j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = (j * nu + i) * 3
        const d = Math.hypot(grid.pts[k] - c.u * a, grid.pts[k + 2] - c.w * b)
        if (d > 1.6) continue
        const score = grid.pts[k + 1] - 0.3 * d
        if (score > best.score) best = { i, j, score }
      }
    }
    return { name: c.name, i: best.i, j: best.j }
  })
  return { spec: s, grid, cuspTips }
}
