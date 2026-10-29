import * as THREE from 'three'
import { parseScan } from '../core/meshConvert'
import { toothClassOf } from '../crown/anatomy'
import { choosePrep, findPrep } from '../crown/findPrep'
import { SurfaceIndex, type ToothFrame, type Vec3 } from '../crown/geom'
import { fdiToUniversal } from '../crown/library'
import { marginFromTaps } from '../crown/margin'
import { MATERIALS } from '../crown/materials'
import { NEW_ORDER, checkScan, occlusionWarning, scanSlots, type ScanStats } from '../crown/order'
import { autoDesign, prepareCase, type DesignResult } from '../crown/pipeline'
import { parseShapeModel, templateFromModel } from '../crown/ssm'
import { designFromDonors, parseDonorSet } from '../crown/donors'
import type { CriticResult } from '../crown/critics'
import type { DesignParams } from '../crown/design'
import type { CrownGrid } from '../crown/grid'
import { CONTRACT, ENGINE_VERSION, validateJob, type CrownJob, type CrownOutcome, type DesignRecord, type ScanInput, type Verdict } from './contract'

/**
 * The module's one entry point: a CrownJob in, a CrownOutcome out, with no
 * UI and no network. Runs the whole automated design — intake checks, find
 * the prep from the bite, margin, axis, anatomy, contacts, occlusion,
 * thickness, QC — and stops with `needs-input` (never a guess) when it
 * can't do a step on its own. Works in a browser worker and in Node.
 */
/** `dev.onStage` sees the outer surface after each design stage (tooth-local grid); for tools and tests only. */
export function designCase(job: CrownJob, dev?: { onStage?: (stage: string, g: CrownGrid) => void }): CrownOutcome {
  const base = { contract: CONTRACT, jobId: job?.jobId ?? '', caseRef: job?.order?.caseRef, engine: { contract: CONTRACT, version: ENGINE_VERSION } } as const
  const problems = validateJob(job)
  if (problems.length) {
    const needs = problems.map((message) => ({ kind: /tooth/i.test(message) ? ('tooth' as const) : /scan/i.test(message) ? ('scan' as const) : /crown/i.test(message) ? ('restoration' as const) : ('scan' as const), message }))
    return job?.contract === CONTRACT ? { ...base, status: 'needs-input', needs } : { ...base, status: 'failed', error: problems.join(' ') }
  }
  try {
    return run(job, base, dev)
  } catch (e) {
    return { ...base, status: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}

function run(job: CrownJob, base: Pick<CrownOutcome, 'contract' | 'jobId' | 'caseRef' | 'engine'>, dev?: { onStage?: (stage: string, g: CrownGrid) => void }): CrownOutcome {
  const t0 = now()
  const timings: Record<string, number> = {}
  const tooth = job.order.system === 'fdi' ? fdiToUniversal(job.order.tooth)! : job.order.tooth
  const material = job.order.material ?? 'zirconia-hs'
  if (!MATERIALS[material]) return { ...base, status: 'needs-input', needs: [{ kind: 'restoration', message: `Unknown material "${material}".` }] }

  // Intake: the same checks the phone shows on each scan card.
  const prepG = toGeometry(job.scans.prep)
  const antG = job.scans.antagonist ? toGeometry(job.scans.antagonist) : null
  const slots = scanSlots({ ...NEW_ORDER, tooth, antagonist: true })
  const intake: string[] = []
  const prepStats = statsOf(prepG)
  intake.push(...checkScan(job.scans.prep.name, prepStats, slots[0]).warnings)
  if (antG) {
    const antStats = statsOf(antG)
    intake.push(...checkScan(job.scans.antagonist!.name, antStats, slots[1]).warnings)
    const w = occlusionWarning(prepStats, antStats)
    if (w) intake.push(w)
  }
  timings.read = lap(t0)

  const pc = prepareCase({ toothNumber: tooth, prep: prepG, antagonist: antG })

  // Where the prep is: the host's margin, the host's point, or the bite.
  let prepFoundBy: CrownOutcome['prepFoundBy']
  let tap: Vec3 | undefined
  let margin
  if (job.options?.margin?.length) {
    margin = marginFromTaps(pc.prepIndex, job.options.margin)
    prepFoundBy = 'margin-given'
  } else if (job.options?.tap) {
    tap = job.options.tap
    prepFoundBy = 'host'
  } else {
    const g = findPrep(pc.prepIndex, pc.antagonist ? new SurfaceIndex(pc.antagonist.clone()) : null, tooth)
    // Of the teeth out of contact, the one with a clear finish line all round.
    const pick = choosePrep(pc.prepIndex, g)
    if (!pick.point) {
      return { ...base, status: 'needs-input', tooth, intake, needs: [{ kind: 'prep-location', message: pick.reason }], timingsMs: { ...timings, find: lap(t0) } }
    }
    tap = pick.point
    prepFoundBy = 'bite'
    margin = pick.margin
  }
  timings.find = lap(t0)

  // Anatomy: the lab's library/learned model for this tooth class, if given.
  const cls = toothClassOf(tooth)
  // The library's own tooth for this position wins over a blended class model.
  const modelJson = job.options?.anatomy?.[`t${tooth}`] ?? job.options?.anatomy?.[cls]
  const model = modelJson ? parseShapeModel(modelJson) : null
  const template = model && model.cls === cls ? templateFromModel(model) : undefined
  const anatomy = template ? `library — ${(JSON.parse(modelJson!) as { source?: string }).source ?? cls}` : 'textbook — no library tooth for this position'

  // The lab's own finished crowns for this class, when given: each is tried and
  // the one that needed the least reshaping to fit this case is kept.
  const donorJson = job.options?.anatomy?.[`donors-${cls}`]
  const donors = donorJson ? parseDonorSet(donorJson) : null

  let r: DesignResult
  let anatomyUsed = anatomy
  try {
    const req = { tap, margin, params: { ...job.options?.params, material }, onStage: dev?.onStage }
    const pick = donors && donors.cls === cls ? designFromDonors(pc, req, donors) : null
    if (pick) {
      r = pick.result
      anatomyUsed = `lab crown ${pick.donor} — least reshaping (${pick.reshapingMm.toFixed(2)} mm) of ${pick.tried}`
    } else r = autoDesign(pc, { ...req, template })
  } catch (e) {
    return { ...base, status: 'needs-input', tooth, intake, prepFoundBy, needs: [{ kind: 'margin', message: e instanceof Error ? e.message : String(e) }] }
  }
  timings.design = lap(t0)
  return {
    ...assembleOutcome({
      job,
      tooth,
      results: r.report.results,
      summary: r.report.summary,
      volumeMm3: r.watertight.volumeMm3,
      margin: r.margin,
      params: r.params,
      frame: r.frame,
      positions: (r.crown.getAttribute('position') as THREE.BufferAttribute).array as Float32Array,
      indices: (r.crown.index as THREE.BufferAttribute).array as Uint32Array,
      prepFoundBy,
      anatomy: anatomyUsed,
      intake
    }),
    timingsMs: { ...timings, ...r.timingsMs }
  }
}

/** What a finished design becomes on the wire — shared by designCase and the embedded studio. */
export function assembleOutcome(a: {
  job: CrownJob
  tooth: number
  results: CriticResult[]
  summary: { minAxialThicknessMm: number; minOcclusalThicknessMm: number; mesialContactMm: number | null; distalContactMm: number | null; occlusalMinMm: number | null }
  volumeMm3: number
  margin: { points: Vec3[]; confidence: number[] }
  params: DesignParams
  frame: ToothFrame
  positions: Float32Array
  indices: Uint32Array
  prepFoundBy: CrownOutcome['prepFoundBy']
  anatomy: string
  intake: string[]
}): CrownOutcome {
  const { job, tooth } = a
  const material = a.params.material
  const verdict: Verdict = a.results.some((x) => x.verdict === 'fail') ? 'blocked' : a.results.some((x) => x.verdict === 'warn') ? 'review' : 'ready'
  const align = job.options?.alignInsertionToZ ?? false
  const record: DesignRecord = {
    app: 'SayCAD Crowns',
    contract: CONTRACT,
    engineVersion: ENGINE_VERSION,
    createdAt: new Date().toISOString(),
    jobId: job.jobId,
    caseRef: job.order.caseRef,
    tooth,
    material,
    shade: job.order.shade,
    scans: [
      { name: job.scans.prep.name, role: 'prep' as const },
      ...(job.scans.antagonist ? [{ name: job.scans.antagonist.name, role: 'antagonist' as const }] : []),
      ...(job.scans.bite ?? []).map((b) => ({ name: b.name, role: 'bite' as const })),
      ...(job.scans.preop ? [{ name: job.scans.preop.name, role: 'preop' as const }] : [])
    ],
    params: a.params,
    margin: a.margin.points,
    prepFoundBy: a.prepFoundBy,
    anatomy: a.anatomy,
    checks: a.results,
    alignedToZ: align,
    frame: a.frame
  }
  const date = record.createdAt.slice(0, 10).replace(/-/g, '')
  const conf = a.margin.confidence
  return {
    contract: CONTRACT,
    jobId: job.jobId,
    caseRef: job.order.caseRef,
    engine: { contract: CONTRACT, version: ENGINE_VERSION },
    status: 'designed',
    verdict,
    tooth,
    checks: a.results,
    summary: {
      minAxialThicknessMm: a.summary.minAxialThicknessMm,
      minOcclusalThicknessMm: a.summary.minOcclusalThicknessMm,
      mesialContactMm: a.summary.mesialContactMm,
      distalContactMm: a.summary.distalContactMm,
      occlusalMinMm: a.summary.occlusalMinMm,
      volumeMm3: a.volumeMm3,
      marginConfidence: conf.reduce((x, y) => x + y, 0) / Math.max(1, conf.length)
    },
    intake: a.intake,
    prepFoundBy: a.prepFoundBy,
    anatomy: a.anatomy,
    files: { crownStl: binaryStl(a.positions, a.indices, align ? a.frame : null), crownStlName: `crown_${job.order.caseRef ?? job.jobId}_${tooth}_${material}_${date}.stl`, designRecord: record }
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const lap = (t0: number): number => Math.round(now() - t0)

function toGeometry(s: ScanInput): THREE.BufferGeometry {
  if ('mesh' in s) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(s.mesh.positions, 3))
    if (s.mesh.indices) g.setIndex(new THREE.BufferAttribute(s.mesh.indices, 1))
    return g
  }
  const g = parseScan(s.name, s.data)
  if (!g.getAttribute('position')?.count) throw new Error(`${s.name} has no geometry.`)
  return g
}

function statsOf(g: THREE.BufferGeometry): ScanStats {
  g.computeBoundingBox()
  const b = g.boundingBox!
  const tri = (g.index ? g.index.count : g.getAttribute('position').count) / 3
  return { triangles: Math.round(tri), size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z], min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] }
}

/** Binary STL of an indexed mesh; optionally moved so the insertion axis is +Z at the margin centre. */
export function binaryStl(positions: Float32Array, indices: Uint32Array, frame: ToothFrame | null): ArrayBuffer {
  const tris = indices.length / 3
  const buf = new ArrayBuffer(84 + tris * 50)
  const v = new DataView(buf)
  const header = `SayCAD crown ${CONTRACT}`
  for (let k = 0; k < header.length && k < 80; k++) v.setUint8(k, header.charCodeAt(k))
  v.setUint32(80, tris, true)
  const P = (i: number): Vec3 => {
    const p: Vec3 = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]
    if (!frame) return p
    const d: Vec3 = [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]]
    const dot = (a: Vec3): number => a[0] * d[0] + a[1] * d[1] + a[2] * d[2]
    return [dot(frame.mesial), dot(frame.buccal), dot(frame.occlusal)]
  }
  // A mirrored frame (left/right) flips handedness: swap winding to keep normals out.
  const m = frame ? frame.mesial : null
  const flip = frame && m ? det3(frame.mesial, frame.buccal, frame.occlusal) < 0 : false
  let o = 84
  for (let t = 0; t < tris; t++) {
    const a = P(indices[t * 3])
    let b = P(indices[t * 3 + 1])
    let c = P(indices[t * 3 + 2])
    if (flip) [b, c] = [c, b]
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2]
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l
    ny /= l
    nz /= l
    for (const x of [nx, ny, nz, ...a, ...b, ...c]) {
      v.setFloat32(o, x, true)
      o += 4
    }
    v.setUint16(o, 0, true)
    o += 2
  }
  return buf
}

const det3 = (a: Vec3, b: Vec3, c: Vec3): number => a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
