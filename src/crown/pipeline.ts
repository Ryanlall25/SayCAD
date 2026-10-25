import * as THREE from 'three'
import { toothClassOf, type Template } from './anatomy'
import { runCritics, type CriticReport } from './critics'
import { DEFAULT_PARAMS, designOuter, resolvedMaterial, type DesignParams, type OuterResult } from './design'
import { estimateFrame } from './frame'
import { add, geometryFrom, geometryToLocal, normalize, scale, SurfaceIndex, toLocal, type ToothFrame, type Vec3 } from './geom'
import { angleDiff, type CrownGrid } from './grid'
import { buildIntaglio, type IntaglioResult } from './intaglio'
import { detectMargin, type MarginResult } from './margin'
import { MATERIALS } from './materials'
import { weld } from './slice'
import { checkWatertight, gridTriangles, solidToWorld, stitchSolid, type WatertightReport } from './solid'

/**
 * Auto-design, end to end: one tap on the prep → a finished, checked,
 * exportable crown. Each stage's output is kept on the result so the UI can
 * show it and so a person (or the AI layer) can override any stage — edit
 * the margin, flip the buccal, change params — and re-run from there.
 */

export interface CrownCase {
  toothNumber: number
  /** Prep-arch scan, world coordinates. */
  prep: THREE.BufferGeometry
  /** Opposing-arch scan, already registered in occlusion. */
  antagonist?: THREE.BufferGeometry | null
}

export interface PreparedCase {
  toothNumber: number
  prepWelded: THREE.BufferGeometry
  prepIndex: SurfaceIndex
  antagonist: THREE.BufferGeometry | null
}

export interface DesignRequest {
  /** Tap on the prep (world). Required unless `margin` is given. */
  tap?: Vec3
  /** Margin override (world), e.g. after manual edits. */
  margin?: MarginResult
  params?: Partial<DesignParams>
  flipBuccal?: boolean
  nu?: number
  nv?: number
  template?: Template
}

export interface DesignResult {
  toothNumber: number
  margin: MarginResult
  frame: ToothFrame
  buccalConfidence: number
  params: DesignParams
  intaglio: IntaglioResult
  outer: OuterResult
  /** Watertight crown, world coordinates. */
  crown: THREE.BufferGeometry
  /** The crown solid in tooth-local coordinates (for re-analysis). */
  solidLocal: { positions: Float32Array; indices: Uint32Array }
  watertight: WatertightReport
  report: CriticReport
  timingsMs: Record<string, number>
}

export function prepareCase(c: CrownCase): PreparedCase {
  const prepWelded = weld(c.prep)
  return {
    toothNumber: c.toothNumber,
    prepWelded,
    prepIndex: new SurfaceIndex(prepWelded),
    antagonist: c.antagonist ? weld(c.antagonist) : null
  }
}

/** Margin points resampled at the grid's meridian angles (local frame). */
export function marginRowAt(marginLocal: Vec3[], nu: number): Vec3[] {
  const pts = marginLocal
    .map((p) => ({ p, th: (Math.atan2(p[0], p[2]) + 2 * Math.PI) % (2 * Math.PI) }))
    .sort((a, b) => a.th - b.th)
  const row: Vec3[] = []
  let k = 0
  for (let i = 0; i < nu; i++) {
    const th = (2 * Math.PI * i) / nu
    while (k < pts.length - 1 && pts[k + 1].th < th) k++
    const a = pts[k].th <= th ? pts[k] : pts[pts.length - 1]
    const b = pts[k].th <= th ? pts[(k + 1) % pts.length] : pts[0]
    let span = b.th - a.th
    if (span <= 0) span += 2 * Math.PI
    let off = th - a.th
    if (off < 0) off += 2 * Math.PI
    const t = Math.min(1, Math.max(0, off / span))
    // Interpolate in polar form so the row stays on the true loop.
    const ra = Math.hypot(a.p[0], a.p[2])
    const rb = Math.hypot(b.p[0], b.p[2])
    const r = ra + (rb - ra) * t
    const y = a.p[1] + (b.p[1] - a.p[1]) * t
    row.push([r * Math.sin(th), y, r * Math.cos(th)])
  }
  return row
}

/** Splits the prep-arch scan into mesial / distal neighbour surfaces (local). */
export function neighbourSurfaces(prepLocal: THREE.BufferGeometry, marginRow: Vec3[]): { mesial: SurfaceIndex | null; distal: SurfaceIndex | null } {
  const nu = marginRow.length
  const marginR = marginRow.map((p) => Math.hypot(p[0], p[2]))
  const minY = Math.min(...marginRow.map((p) => p[1]))
  const pos = prepLocal.getAttribute('position') as THREE.BufferAttribute
  const idx = prepLocal.index as THREE.BufferAttribute
  const mes: number[] = []
  const dis: number[] = []
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2)
    const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3
    const cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3
    const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3
    if (cy < minY + 0.5 || cy > 16) continue
    const r = Math.hypot(cx, cz)
    if (r > 16) continue
    const th = (Math.atan2(cx, cz) + 2 * Math.PI) % (2 * Math.PI)
    const mr = marginR[Math.round((th / (2 * Math.PI)) * nu) % nu]
    if (r < mr + 0.35) continue
    const target = angleDiff(th, Math.PI / 2) < (70 * Math.PI) / 180 ? mes : angleDiff(th, (3 * Math.PI) / 2) < (70 * Math.PI) / 180 ? dis : null
    if (!target) continue
    for (const v of [a, b, c]) target.push(pos.getX(v), pos.getY(v), pos.getZ(v))
  }
  const make = (arr: number[]): SurfaceIndex | null => {
    if (arr.length < 9 * 20) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(arr), 3))
    return new SurfaceIndex(g)
  }
  return { mesial: make(mes), distal: make(dis) }
}

/** Surface index over a crown grid (open surface, local). */
export function gridSurface(g: CrownGrid): SurfaceIndex {
  const positions = new Float32Array(g.nu * g.nv * 3 + 3)
  positions.set(g.pts)
  positions.set(g.pole, g.nu * g.nv * 3)
  const idx: number[] = []
  gridTriangles(g.nu, g.nv, 0, g.nu * g.nv, false, idx)
  return new SurfaceIndex(geometryFrom(positions, idx))
}

interface CaseEnv {
  key: string
  fe: ReturnType<typeof estimateFrame>
  prepLocal: THREE.BufferGeometry
  marginRow: Vec3[]
  mesial: SurfaceIndex | null
  distal: SurfaceIndex | null
  antagonist: SurfaceIndex | null
  intaglio: { key: string; result: IntaglioResult; index: SurfaceIndex } | null
}

const envCache = new WeakMap<PreparedCase, CaseEnv>()

/** Cheap content key for a margin loop (exact for identical loops). */
function marginKey(m: MarginResult): string {
  let a = 0
  let b = 0
  m.points.forEach((p, k) => {
    a += p[0] * (k + 1) + p[1] * 3.1 + p[2] * 7.7
    b += p[0] * p[1] - p[2] * (k % 7)
  })
  return `${m.points.length}:${a.toFixed(6)}:${b.toFixed(6)}`
}

export function autoDesign(pc: PreparedCase, req: DesignRequest): DesignResult {
  const t: Record<string, number> = {}
  let t0 = performance.now()
  const lap = (k: string): void => {
    const now = performance.now()
    t[k] = Math.round(now - t0)
    t0 = now
  }
  const nu = req.nu ?? 128
  const nv = req.nv ?? 56
  const params: DesignParams = { ...DEFAULT_PARAMS, ...req.params, sculpt: req.params?.sculpt ?? [] }
  const mat = resolvedMaterial(params)

  let margin = req.margin
  if (!margin) {
    if (!req.tap) throw new Error('autoDesign needs a tap on the prep or a margin')
    margin = detectMargin(pc.prepIndex, req.tap)
  }
  if (margin.points.length < 16) throw new Error('Could not find a margin line around that point — tap the top of the prep.')
  lap('margin')

  // Frame, local scans and neighbour/antagonist BVHs depend only on the
  // margin, orientation and grid size — reuse them across parameter edits.
  const tiltM = params.axisTiltMesialDeg
  const tiltB = params.axisTiltBuccalDeg
  const envKey = `${marginKey(margin)}|${pc.toothNumber}|${req.flipBuccal ? 1 : 0}|${nu}|${nv}|${tiltM}|${tiltB}`
  let env = envCache.get(pc)
  if (!env || env.key !== envKey) {
    let fe = estimateFrame(margin.points, margin.axis.up, pc.toothNumber, pc.prepWelded, { flipBuccal: req.flipBuccal })
    if (tiltM || tiltB) {
      // Technician override of the path of insertion: lean the axis toward
      // mesial/buccal by the given angles, then rebuild the frame around it.
      const f0 = fe.frame
      const t = (deg: number): number => Math.tan((deg * Math.PI) / 180)
      const up = normalize(add(add(f0.occlusal, scale(f0.mesial, t(tiltM))), scale(f0.buccal, t(tiltB))))
      fe = { ...estimateFrame(margin.points, up, pc.toothNumber, pc.prepWelded, { flipBuccal: req.flipBuccal }), buccalConfidence: fe.buccalConfidence }
    }
    const prepLocal = geometryToLocal(fe.frame, pc.prepWelded)
    const antLocal = pc.antagonist ? geometryToLocal(fe.frame, pc.antagonist) : null
    const marginRow = marginRowAt(margin.points.map((p) => toLocal(fe.frame, p)), nu)
    env = { key: envKey, fe, prepLocal, marginRow, ...neighbourSurfaces(prepLocal, marginRow), antagonist: antLocal ? new SurfaceIndex(antLocal) : null, intaglio: null }
    envCache.set(pc, env)
  }
  const { fe, prepLocal, marginRow, mesial, distal, antagonist } = env
  const frame = fe.frame
  lap('frame')

  const iKey = `${mat.cementGapMm}|${params.marginBandMm}|${params.marginGapMm}`
  if (!env.intaglio || env.intaglio.key !== iKey) {
    const result = buildIntaglio(prepLocal, marginRow, nv, {
      cementGapMm: mat.cementGapMm,
      marginBandMm: params.marginBandMm,
      marginGapMm: params.marginGapMm
    })
    env.intaglio = { key: iKey, result, index: gridSurface(result.grid) }
  }
  const intaglio = env.intaglio.result
  const intaglioIndex = env.intaglio.index
  lap('intaglio')

  const outer = designOuter(
    { toothClass: toothClassOf(pc.toothNumber), marginRow, intaglio: intaglio.grid, intaglioIndex, mesial, distal, antagonist, nv, templateOverride: req.template },
    params
  )
  lap('outer')

  const solidLocal = stitchSolid(outer.grid, intaglio.grid)
  const watertight = checkWatertight(solidLocal.positions, solidLocal.indices)
  const crown = solidToWorld(solidLocal, frame)
  lap('solid')

  const lowConf = margin.confidence.length ? margin.confidence.filter((c) => c < 0.35).length / margin.confidence.length : 1
  const report = runCritics({
    outer: outer.grid,
    intaglioIndex,
    intaglioPoleY: intaglio.grid.pole[1],
    mesial,
    distal,
    antagonist,
    watertight,
    material: { ...mat, label: MATERIALS[params.material]?.label ?? params.material },
    targets: { contactMesialMm: params.contactMesialMm, contactDistalMm: params.contactDistalMm, occlusalClearanceMm: params.occlusalClearanceMm },
    marginConfidenceLowFraction: lowConf,
    marginMissingFraction: margin.missingFraction,
    buccalConfidence: fe.buccalConfidence,
    maxUndercutMm: intaglio.maxUndercutMm,
    blockoutVolumeMm3: intaglio.blockoutVolumeMm3,
    openContacts: outer.measures.openContacts
  })
  lap('critics')

  return {
    toothNumber: pc.toothNumber,
    margin,
    frame,
    buccalConfidence: fe.buccalConfidence,
    params,
    intaglio,
    outer,
    crown,
    solidLocal,
    watertight,
    report,
    timingsMs: t
  }
}
