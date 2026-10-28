import type { ToothClass } from './anatomy'
import type { CrownGrid } from './grid'
import { autoDesign, type DesignRequest, type DesignResult, type PreparedCase } from './pipeline'
import { parseShapeModel, templateFromModel, type ShapeModel } from './ssm'

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
  donors: Array<{ id: string; tooth?: number; model: ShapeModel }>
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
  const donors = set.donors.filter((d) => d.id !== opts.exclude).slice(0, opts.maxDonors ?? 12)
  let best: (DonorChoice & { passes: boolean }) | null = null
  let margin = req.margin
  let tap = req.tap
  for (const d of donors) {
    let fitted: CrownGrid | null = null
    let final: CrownGrid | null = null
    const r = autoDesign(pc, {
      ...req,
      tap: margin ? undefined : tap,
      margin,
      template: templateFromModel(d.model),
      onStage: (s, g) => {
        if (s === 'emergence') fitted = { ...g, pts: g.pts.slice() }
        if (s === 'final') final = g
      }
    })
    // Every donor designs to the same margin as the first.
    margin = r.margin
    tap = undefined
    if (!fitted || !final) continue
    const passes = !r.report.results.some((x) => x.verdict === 'fail')
    const c = { result: r, donor: d.id, reshapingMm: reshaping(fitted, final), tried: donors.length, passes }
    if (!best || (c.passes && !best.passes) || (c.passes === best.passes && c.reshapingMm < best.reshapingMm)) best = c
  }
  return best
}
