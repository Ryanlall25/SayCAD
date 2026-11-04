import type { Template, ToothClass } from './anatomy'
import type { CrownGrid } from './grid'
import { autoDesign, type DesignRequest, type DesignResult, type PreparedCase } from './pipeline'
import { parseShapeModel, templateFromModel, type ShapeModel } from './ssm'
import { gridBounds } from './grid'
import { toothSide } from './findPrep'
import type { Vec3 } from './geom'

/**
 * Starting anatomy from the lab's own finished crowns.
 *
 * Averaging technicians' crowns blurs cusps and grooves (they don't line up
 * crown to crown), so a learned mean is no deeper than a textbook tooth.
 * Instead the case is designed from each of the closest few real crowns
 * ("donors") and the one the contact, bite and thickness steps had to
 * reshape least is kept: it already fitted this margin, these neighbours
 * and this bite. Measured leave-one-out on 9 lower first molars, this came
 * within 0.01 mm of the donor that was truly closest to the technician's
 * own crown (and 24 % closer than the bundled library tooth).
 */

export interface DonorSet {
  version: 1
  cls: ToothClass
  /** One single-crown shape model per donor, normalised to the class reference. */
  donors: Array<{ id: string; tooth?: number; model: ShapeModel; size?: { md: number; bl: number; h: number } }>
}

/**
 * A donor's template with its own real proportions: stored shapes are
 * normalised per axis to the class reference, which loses each crown's
 * height-to-width ratio (a 0.52 crown came back 0.64 — 1.6 mm too tall).
 */
export function donorTemplate(d: DonorSet['donors'][number]): Template {
  const t = templateFromModel(d.model)
  if (!d.size) return t
  const b = gridBounds(t.grid)
  const s: Vec3 = [d.size.md / (b.max[0] - b.min[0]), d.size.h / (b.max[1] - b.min[1]), d.size.bl / (b.max[2] - b.min[2])]
  const g = { ...t.grid, pts: t.grid.pts.slice() }
  for (let k = 0; k < g.pts.length; k += 3) {
    g.pts[k] *= s[0]
    g.pts[k + 1] = (g.pts[k + 1] - b.min[1]) * s[1] + b.min[1]
    g.pts[k + 2] *= s[2]
  }
  g.pole = [t.grid.pole[0] * s[0], (t.grid.pole[1] - b.min[1]) * s[1] + b.min[1], t.grid.pole[2] * s[2]]
  return { ...t, grid: g }
}

export function parseDonorSet(json: string): DonorSet | null {
  try {
    const d = JSON.parse(json) as DonorSet
    if (d.version !== 1 || !Array.isArray(d.donors)) return null
    const donors = d.donors.filter((x) => parseShapeModel(JSON.stringify(x.model)))
    return donors.length ? { ...d, donors } : null
  } catch {
    return null
  }
}

/** Mean per-vertex distance the steps after emergence moved the surface (mm). */
function reshaping(before: CrownGrid, after: CrownGrid): number {
  let s = 0
  for (let k = 0; k < after.pts.length; k += 3) s += Math.hypot(after.pts[k] - before.pts[k], after.pts[k + 1] - before.pts[k + 1], after.pts[k + 2] - before.pts[k + 2])
  return s / (after.pts.length / 3)
}

/** Cusp relief: spread (5th–95th percentile) of heights over the top 30 % of rows (mm). */
export function occlusalRelief(g: CrownGrid): number {
  const h: number[] = []
  for (let j = Math.ceil(g.nv * 0.7); j < g.nv; j++) for (let i = 0; i < g.nu; i++) h.push(g.pts[(j * g.nu + i) * 3 + 1])
  h.sort((a, b) => a - b)
  return h.length ? h[Math.floor(h.length * 0.95)] - h[Math.floor(h.length * 0.05)] : 0
}

// mm of reshaping a millimetre of missing relief costs — molars only. On 16
// lab upper molars 0.6 brought relief from 1.27 to 1.49 mm (technicians'
// 1.56), mean deviation 0.216 → 0.209 mm; lower molars 0.176 → 0.174.
// Premolars weren't flat (lower 1.34 vs 1.42 mm) and lost 0.005–0.007 mm.
const FLAT_WEIGHT = (cls: string): number => (cls.endsWith('Molar') ? 0.6 : 0)

const CONSENSUS_WEIGHT = Number((globalThis as any).process?.env?.DONOR_CONSENSUS ?? 0)

/** Mean distance between corresponding vertices of two grids on one margin (mm). */
function gridDistance(a: CrownGrid, b: CrownGrid): number {
  if (a.pts.length !== b.pts.length) return Infinity
  let sum = 0
  const n = a.pts.length / 3
  for (let k = 0; k < a.pts.length; k += 3) sum += Math.hypot(a.pts[k] - b.pts[k], a.pts[k + 1] - b.pts[k + 1], a.pts[k + 2] - b.pts[k + 2])
  return sum / n
}

export interface DonorChoice {
  result: DesignResult
  donor: string
  reshapingMm: number
  tried: number
}

/**
 * Designs from each donor (on one fixed margin) and keeps the least-reshaped
 * design that passes every check, or the least-reshaped overall.
 */
export function designFromDonors(pc: PreparedCase, req: DesignRequest, set: DonorSet, opts: { maxDonors?: number; exclude?: string } = {}): DonorChoice | null {
  const all = set.donors.filter((d) => d.id !== opts.exclude)
  // Same position in the arch first: a class spans teeth of different form
  // (lower first molars have five cusps, second molars four).
  const pos = toothSide(pc.toothNumber).pos
  const same = all.filter((d) => d.tooth !== undefined && toothSide(d.tooth).pos === pos)
  const donors = (same.length >= 3 ? same : all).slice(0, opts.maxDonors ?? 24)
  // The set's usual cusp relief: least reshaping alone favoured flat donors
  // (tall cusps need carving to the bite), and the chosen upper molars came
  // out 20 % flatter than the technicians' (1.27 vs 1.58 mm); with each
  // case's own crown the relief survived the steps (1.59 vs 1.55).
  const reliefs = donors.map((d) => occlusalRelief(donorTemplate(d).grid)).sort((a, b) => a - b)
  const usual = reliefs[Math.floor(reliefs.length / 2)] ?? 0
  const w = FLAT_WEIGHT(set.cls)
  const score = (r: number, g: CrownGrid): number => r + w * Math.max(0, usual - occlusalRelief(g))
  type Cand = DonorChoice & { passes: boolean; stages: Array<[string, CrownGrid]>; score: number; final: CrownGrid }
  const cands: Cand[] = []
  let margin = req.margin
  let tap = req.tap
  for (const d of donors) {
    let fitted: CrownGrid | null = null
    let final: CrownGrid | null = null
    const stages: Array<[string, CrownGrid]> = []
    const r = autoDesign(pc, {
      ...req,
      tap: margin ? undefined : tap,
      margin,
      template: donorTemplate(d),
      onStage: (s, g) => {
        if (req.onStage) stages.push([s, { ...g, pts: g.pts.slice(), pole: [...g.pole] as CrownGrid['pole'] }])
        if (s === 'emergence') fitted = { ...g, pts: g.pts.slice() }
        if (s === 'final') final = g
      }
    })
    // Every donor designs to the same margin as the first.
    margin = r.margin
    tap = undefined
    if (!fitted || !final) continue
    const passes = !r.report.results.some((x) => x.verdict === 'fail')
    const rs = reshaping(fitted, final)
    const fin = final as CrownGrid
    cands.push({ result: r, donor: d.id, reshapingMm: rs, tried: donors.length, passes, stages, score: score(rs, fin), final: { ...fin, pts: fin.pts.slice() } })
  }
  // Consensus: each design's mean distance to the other passing designs. The
  // least-reshaped alone flipped between near-equal donors on small pipeline
  // changes, 0.07–0.1 mm from the technician's crown each time (054, 012).
  const pool = cands.filter((c) => c.passes)
  if (CONSENSUS_WEIGHT > 0 && pool.length >= 3) {
    for (const c of pool) {
      let sum = 0
      for (const o of pool) if (o !== c) sum += gridDistance(c.final, o.final)
      c.score += CONSENSUS_WEIGHT * (sum / (pool.length - 1))
    }
  }
  let best: Cand | null = null
  for (const c of cands) if (!best || (c.passes && !best.passes) || (c.passes === best.passes && c.score < best.score)) best = c
  // The caller's stage hook sees the chosen design only.
  if (best && req.onStage) for (const [s, g] of best.stages) req.onStage(s, g)
  return best
}
