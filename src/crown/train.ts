import * as THREE from 'three'
import { toothClassOf, type ToothClass } from './anatomy'
import { estimateFrame } from './frame'
import { SurfaceIndex, toLocal, toWorld, type ToothFrame } from './geom'
import { detectMargin, marginError } from './margin'
import { autoDesign, prepareCase } from './pipeline'
import { weld } from './slice'
import { normaliseToReference, sampleCrownOuter, surfaceDeviation, templateFromModel, trainShapeModel, type ShapeModel } from './ssm'
import type { CrownGrid } from './grid'

/**
 * Learning from the lab's finished cases, and measuring the result.
 *
 * A training case is what the lab already has for every crown it shipped:
 * the prep-arch scan, the opposing scan, and the crown the technician
 * designed (STL). For each case this module
 *   - runs the engine's own margin finder on the prep scan and scores it
 *     against the margin of the crown the technician actually shipped;
 *   - re-samples the technician's crown on the crown grid in the engine's
 *     own frame (so learned anatomy is in exactly the coordinates the
 *     designer uses);
 * then learns one shape model per tooth class, and — the number that
 * matters — scores auto-designs against the technician's crowns with
 * leave-one-out (each case designed by a model that never saw it).
 */

export interface TrainingCase {
  id: string
  toothNumber: number
  prep: THREE.BufferGeometry
  antagonist?: THREE.BufferGeometry | null
  /** The crown the technician designed and shipped. */
  crown: THREE.BufferGeometry
}

export interface CaseAnalysis {
  id: string
  toothNumber: number
  cls: ToothClass
  ok: boolean
  error?: string
  frame?: ToothFrame
  /** Engine margin vs the shipped crown's margin, mm. */
  marginError?: { mean: number; p95: number; max: number }
  /** Technician crown on the grid, normalised to the class reference. */
  shape?: CrownGrid
}

export interface EvaluationRow {
  id: string
  cls: ToothClass
  /** Learned model, leave-one-out. */
  learned?: { mean: number; p90: number; max: number }
  /** Textbook template. */
  textbook: { mean: number; p90: number; max: number }
  exportable: boolean
}

const NU = 128
const NV = 56

/** Where a person would tap: the prep surface nearest the crown's centre. */
function tapFromCrown(prep: SurfaceIndex, crown: THREE.BufferGeometry): [number, number, number] | null {
  crown.computeBoundingBox()
  const c = new THREE.Vector3()
  crown.boundingBox!.getCenter(c)
  return prep.closest([c.x, c.y, c.z], 20)?.point ?? null
}

export function analyseCase(tc: TrainingCase): CaseAnalysis {
  const cls = toothClassOf(tc.toothNumber)
  try {
    const prepW = weld(tc.prep)
    const prep = new SurfaceIndex(prepW)
    const tap = tapFromCrown(prep, tc.crown)
    if (!tap) return { id: tc.id, toothNumber: tc.toothNumber, cls, ok: false, error: 'crown is not over the prep scan (are the files registered?)' }
    const margin = detectMargin(prep, tap)
    if (margin.points.length < 16) return { id: tc.id, toothNumber: tc.toothNumber, cls, ok: false, error: 'margin not found' }
    const { frame } = estimateFrame(margin.points, margin.axis.up, tc.toothNumber, prepW)
    const sampled = sampleCrownOuter(tc.crown, frame, NU, NV)
    if (!sampled) return { id: tc.id, toothNumber: tc.toothNumber, cls, ok: false, error: 'could not trace the crown on the grid' }
    const crownMarginWorld = sampled.margin.map((p) => toWorld(frame, p))
    return {
      id: tc.id,
      toothNumber: tc.toothNumber,
      cls,
      ok: true,
      frame,
      marginError: marginError(margin.points, crownMarginWorld),
      shape: normaliseToReference(sampled.grid, cls)
    }
  } catch (e) {
    return { id: tc.id, toothNumber: tc.toothNumber, cls, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function trainModels(analyses: CaseAnalysis[], source = 'lab cases'): Partial<Record<ToothClass, ShapeModel>> {
  const byClass = new Map<ToothClass, CrownGrid[]>()
  for (const a of analyses) if (a.ok && a.shape) (byClass.get(a.cls) ?? byClass.set(a.cls, []).get(a.cls)!).push(a.shape)
  const out: Partial<Record<ToothClass, ShapeModel>> = {}
  for (const [cls, grids] of byClass) out[cls] = trainShapeModel(cls, grids, { source: `${grids.length} ${source}` })
  return out
}

/** Leave-one-out: design each case with a model trained on the others. */
export function evaluate(cases: TrainingCase[], analyses: CaseAnalysis[], onProgress?: (done: number, total: number) => void): EvaluationRow[] {
  const rows: EvaluationRow[] = []
  cases.forEach((tc, k) => {
    const a = analyses[k]
    onProgress?.(k, cases.length)
    if (!a.ok || !a.frame) return
    const pc = prepareCase({ toothNumber: tc.toothNumber, prep: tc.prep, antagonist: tc.antagonist })
    const crownLocal = new SurfaceIndex(weld(tc.crown.clone().applyMatrix4(frameInverse(a.frame))))
    const tap = tapFromCrown(pc.prepIndex, tc.crown)!
    const base = autoDesign(pc, { tap })
    const textbook = surfaceDeviation(base.outer.grid, crownLocal)
    const others = analyses.filter((o, i) => i !== k && o.ok && o.cls === a.cls && o.shape)
    let learned: EvaluationRow['learned']
    let exportable = base.report.exportable
    if (others.length >= 2) {
      const model = trainShapeModel(a.cls, others.map((o) => o.shape!))
      const r = autoDesign(pc, { margin: base.margin, template: templateFromModel(model) })
      learned = surfaceDeviation(r.outer.grid, crownLocal)
      exportable = r.report.exportable
    }
    rows.push({ id: tc.id, cls: a.cls, learned, textbook, exportable })
  })
  onProgress?.(cases.length, cases.length)
  return rows
}

function frameInverse(f: ToothFrame): THREE.Matrix4 {
  const m = new THREE.Matrix4()
  m.set(
    f.mesial[0], f.occlusal[0], f.buccal[0], f.origin[0],
    f.mesial[1], f.occlusal[1], f.buccal[1], f.origin[1],
    f.mesial[2], f.occlusal[2], f.buccal[2], f.origin[2],
    0, 0, 0, 1
  )
  return m.invert()
}

/** Markdown report of a training + evaluation run. */
export function trainingReport(analyses: CaseAnalysis[], models: Partial<Record<ToothClass, ShapeModel>>, rows: EvaluationRow[]): string {
  const ok = analyses.filter((a) => a.ok)
  const lines: string[] = []
  lines.push('# Crown engine — training & evaluation report', '')
  lines.push(`Cases: ${analyses.length} (${ok.length} usable, ${analyses.length - ok.length} skipped)`, '')
  const skipped = analyses.filter((a) => !a.ok)
  if (skipped.length) {
    lines.push('## Skipped cases', '', '| case | tooth | reason |', '|---|---|---|')
    for (const s of skipped) lines.push(`| ${s.id} | ${s.toothNumber} | ${s.error} |`)
    lines.push('')
  }
  const me = ok.map((a) => a.marginError!.mean).sort((x, y) => x - y)
  if (me.length) {
    lines.push('## Margin detection vs shipped crowns', '')
    lines.push(`Median of per-case mean error: **${me[Math.floor(me.length / 2)].toFixed(3)} mm**; worst case mean: ${me[me.length - 1].toFixed(3)} mm.`, '')
    lines.push('| case | tooth | mean | p95 | max |', '|---|---|---|---|---|')
    for (const a of ok) lines.push(`| ${a.id} | ${a.toothNumber} | ${a.marginError!.mean.toFixed(3)} | ${a.marginError!.p95.toFixed(3)} | ${a.marginError!.max.toFixed(3)} |`)
    lines.push('')
  }
  lines.push('## Learned shape models', '', '| class | crowns | modes | variance in first 3 modes |', '|---|---|---|---|')
  for (const [cls, m] of Object.entries(models)) {
    if (!m) continue
    lines.push(`| ${cls} | ${m.count} | ${m.modes.length} | ${(m.explained.slice(0, 3).reduce((s, x) => s + x, 0) * 100).toFixed(0)}% |`)
  }
  lines.push('')
  if (rows.length) {
    lines.push('## Auto-design vs the technician’s crown (leave-one-out)', '')
    lines.push('Surface deviation of the auto-designed outer surface from the shipped crown, excluding the 1 mm margin band (mm).', '')
    lines.push('| case | class | learned mean | learned p90 | textbook mean | textbook p90 | passes QC |', '|---|---|---|---|---|---|---|')
    for (const r of rows) {
      lines.push(`| ${r.id} | ${r.cls} | ${r.learned ? r.learned.mean.toFixed(3) : 'n/a'} | ${r.learned ? r.learned.p90.toFixed(3) : 'n/a'} | ${r.textbook.mean.toFixed(3)} | ${r.textbook.p90.toFixed(3)} | ${r.exportable ? 'yes' : 'no'} |`)
    }
    const lm = rows.filter((r) => r.learned).map((r) => r.learned!.mean)
    const tm = rows.map((r) => r.textbook.mean)
    const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
    lines.push('', `Average mean deviation — learned: **${lm.length ? avg(lm).toFixed(3) : 'n/a'} mm**, textbook: **${avg(tm).toFixed(3)} mm**.`)
  }
  return lines.join('\n') + '\n'
}
