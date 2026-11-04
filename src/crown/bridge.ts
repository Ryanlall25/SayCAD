import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { toothClassOf, type ToothClass } from './anatomy'
import { designFromDonors, donorTemplate, occlusalRelief, type DonorSet } from './donors'
import { bestMargin, findPrep, findPrepDeep, marginScoreOf, scorePreps, toothSide } from './findPrep'
import { SurfaceIndex, add, cross, dot, normalize, scale, sub, toLocal, toWorld, type ToothFrame, type Vec3 } from './geom'
import type { CrownGrid } from './grid'
import { commonAxis } from './insertion'
import { fdiToUniversal } from './library'
import { marginFromTaps, type MarginResult } from './margin'
import { prepareCase, type DesignResult } from './pipeline'

/**
 * Three-unit posterior bridges: two abutment crowns and a pontic, joined by
 * connectors into one solid.
 *
 * What the lab's own bridges set (four 3-unit posterior bridges, technician's
 * designs): connectors 13–22 mm² where a molar is involved, 6–8 mm² on an
 * upper premolar bridge; pontic bases rest on the ridge (median gap
 * 0.07–0.17 mm, 40–64 % of the base within 0.1 mm), clearing toward the
 * embrasures.
 *
 * Steps: one path of insertion both preps share; each abutment designed by
 * the crown engine along it; the pontic from a donor crown of its position,
 * sized to the gap, its base built down onto the ridge; elliptical
 * connectors at the proximal planes; union; the prep cavities cut back out
 * so a connector can't fill an intaglio.
 */

export interface BridgeUnit {
  /** FDI tooth number. */
  fdi: number
  role: 'abutment' | 'pontic'
  /** Abutments: margin points (world), any order. */
  margin?: Vec3[]
}

export interface BridgeRequest {
  prep: THREE.BufferGeometry
  antagonist: THREE.BufferGeometry | null
  units: BridgeUnit[]
  donors: Partial<Record<ToothClass, DonorSet>>
  /** Connector cross-section target (mm²); default 12 with a molar in the span, else 9. */
  connectorMm2?: number
  occlusalClearanceMm?: number
}

export interface ConnectorReport {
  between: [number, number]
  targetMm2: number
  widthMm: number
  heightMm: number
  /** Closest approach of the connector to the gum below it (mm): room to clean under it. */
  gumClearanceMm: number | null
  /** Closest approach to the opposing teeth (mm, negative = into them). */
  biteClearanceMm: number | null
}

export interface BridgeResult {
  /** The bridge as one solid, world coordinates. */
  positions: Float32Array
  indices: Uint32Array
  manifoldOk: boolean
  genus: number
  volumeMm3: number
  axis: Vec3
  axisBlockoutMm3: number[]
  abutments: Array<{ fdi: number; result: DesignResult; donor: string }>
  pontic: { fdi: number; donor: string; frame: ToothFrame; gapMm: number }
  connectors: ConnectorReport[]
  /** What stops this bridge going to the mill as is (empty: ready for approval). */
  blockers: string[]
  notes: string[]
}

type Wasm = Awaited<ReturnType<typeof import('manifold-3d').default>>
let wasmP: Promise<Wasm> | null = null
async function manifold(): Promise<Wasm> {
  if (!wasmP) {
    wasmP = import('manifold-3d').then(async (m) => {
      const w = await m.default()
      w.setup()
      return w
    })
  }
  return wasmP
}

/** Indexed triangle soup (world) to a manifold solid; orientation fixed to outward. */
function toSolid(w: Wasm, positions: ArrayLike<number>, indices: ArrayLike<number>): InstanceType<Wasm['Manifold']> {
  let g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(positions), 3))
  g.setIndex(Array.from(indices))
  g = mergeVertices(g.deleteAttribute('normal') ?? g, 1e-5)
  const p = g.getAttribute('position')
  const ix = Uint32Array.from(g.index!.array)
  let vol = 0
  for (let t = 0; t < ix.length; t += 3) {
    const a = [p.getX(ix[t]), p.getY(ix[t]), p.getZ(ix[t])]
    const b = [p.getX(ix[t + 1]), p.getY(ix[t + 1]), p.getZ(ix[t + 1])]
    const c = [p.getX(ix[t + 2]), p.getY(ix[t + 2]), p.getZ(ix[t + 2])]
    vol += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
  }
  if (vol < 0) for (let t = 0; t < ix.length; t += 3) [ix[t + 1], ix[t + 2]] = [ix[t + 2], ix[t + 1]]
  const mesh = new w.Mesh({ numProp: 3, vertProperties: Float32Array.from(p.array as ArrayLike<number>), triVerts: ix })
  mesh.merge()
  return new w.Manifold(mesh)
}

/** Closed surface from rings of nu points (bottom → top) plus a pole at each end. */
function ringsToMesh(bottom: Vec3, rings: Vec3[][], top: Vec3): { positions: number[]; indices: number[] } {
  const nu = rings[0].length
  const positions: number[] = [...bottom]
  for (const r of rings) for (const p of r) positions.push(...p)
  positions.push(...top)
  const at = (k: number, i: number): number => 1 + k * nu + (((i % nu) + nu) % nu)
  const indices: number[] = []
  for (let i = 0; i < nu; i++) indices.push(0, at(0, i + 1), at(0, i))
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < nu; i++) indices.push(at(k, i), at(k, i + 1), at(k + 1, i + 1), at(k, i), at(k + 1, i + 1), at(k + 1, i))
  }
  const T = 1 + rings.length * nu
  const last = rings.length - 1
  for (let i = 0; i < nu; i++) indices.push(T, at(last, i), at(last, i + 1))
  return { positions, indices }
}

const CAVITY_GROW_MM = 0.015
const smoothstep = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const CONNECTOR_OVERSIZE = 1.06
const CONNECTOR_MIN_MM2 = 6
// As for single crowns (choosePrep): the pair's span is a further check.
const AUTO_ABUTMENT_SCORE = 0.45
const AUTO_MAX_MISSING = 0.25
const EMBRASURE_MM = 1.5
const CONNECTOR_HALF_LENGTH_MM = 2.6

const rowOf = (g: CrownGrid, j: number): Vec3[] => Array.from({ length: g.nu }, (_, i) => [g.pts[(j * g.nu + i) * 3], g.pts[(j * g.nu + i) * 3 + 1], g.pts[(j * g.nu + i) * 3 + 2]] as Vec3)

/**
 * The two abutment preps of a bridge, found from the bite: every out-of-contact
 * candidate (usual and deep clearance bands) is scored by how clearly its
 * finish line reads; the best-scoring pair 12–30 mm apart wins. Assigned by
 * margin size — the larger loop to the tooth further back in the arch (a
 * molar's margin is larger than a premolar's); equal classes the same way.
 */
export function findAbutments(index: SurfaceIndex, antagonist: SurfaceIndex, teeth: number[]): MarginResult[] {
  const usual = findPrep(index, antagonist)
  const deep = findPrepDeep(index, antagonist)
  const far = (a: { point: Vec3 }, list: Array<{ point: Vec3 }>) => list.every((c) => Math.hypot(...sub(c.point, a.point)) > 3)
  const cands = [...(usual.candidates ?? [])]
  for (const c of deep.candidates ?? []) if (far(c, cands)) cands.push(c)
  const all = scorePreps(index, { ...usual, point: null, candidates: cands }, 16)
  const scored = all.filter((c) => c.score >= AUTO_ABUTMENT_SCORE)
  const centre = (m: MarginResult): Vec3 => scale(m.points.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / m.points.length)
  let best: [{ margin: MarginResult; score: number; point: Vec3 }, { margin: MarginResult; score: number; point: Vec3 }] | null = null
  let bestS = -Infinity
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const d = Math.hypot(...sub(centre(scored[i].margin), centre(scored[j].margin)))
      if (d < 12 || d > 30) continue
      const s = scored[i].score + scored[j].score
      if (s > bestS) {
        bestS = s
        best = [scored[i], scored[j]]
      }
    }
  }
  // One found, the other not out of contact (no opposing tooth over it —
  // case086's #16): the tooth tops 12–30 mm from the first, each judged by its margin.
  if (!best && scored.length) {
    const first = scored[0]
    const c0 = centre(first.margin)
    const up = normalize(usual.ups?.[0] ?? first.margin.axis.up)
    const pos = index.geometry.getAttribute('position')
    const cells = new Map<string, Vec3>()
    let topH = -Infinity
    for (let i = 0; i < pos.count; i += 3) topH = Math.max(topH, dot([pos.getX(i), pos.getY(i), pos.getZ(i)], up))
    for (let i = 0; i < pos.count; i += 3) {
      const p: Vec3 = [pos.getX(i), pos.getY(i), pos.getZ(i)]
      const d = Math.hypot(...sub(p, c0))
      if (d < 12 || d > 30 || dot(p, up) < topH - 8) continue
      const key = p.map((x) => Math.round(x / 2.5)).join(',')
      const q = cells.get(key)
      if (!q || dot(p, up) > dot(q, up)) cells.set(key, p)
    }
    // Highest cell per 2.5 mm column: a stump's top, not its walls.
    let second: { margin: MarginResult; score: number } | null = null
    for (const seed of cells.values()) {
      if (dot(seed, up) < topH - 6) continue
      const m = bestMargin(index, seed, usual.ups ?? [])
      const sc = marginScoreOf(m)
      const d = m.points.length ? Math.hypot(...sub(centre(m), c0)) : 0
      if (sc >= AUTO_ABUTMENT_SCORE && d >= 12 && d <= 30 && (!second || sc > second.score)) second = { margin: m, score: sc }
    }
    if (second) best = [first, { point: c0, ...second }]
  }
  if (!best) throw new Error('Could not find two abutment preps a bridge span apart — tap both margins.')
  // Each re-traced along the other's direction too: abutments share a path of
  // insertion, and one loop read along a direction 40° off came back 37 %
  // interpolated (case029's #45).
  const pair = best.map((b, k) => {
    const other = best![1 - k].margin.axis.up
    const again = bestMargin(index, b.point, [other, ...(usual.ups ?? [])])
    return marginScoreOf(again) > b.score ? again : b.margin
  })
  best = [{ ...best[0], margin: pair[0] }, { ...best[1], margin: pair[1] }]
  // A loop traced only in part can't carry a crown (case029's #45, 37 %
  // interpolated, came out partly inside out): ask, as for a single crown.
  for (const b of best) if (b.margin.missingFraction > AUTO_MAX_MISSING) throw new Error(`An abutment's finish line is only partly visible (${Math.round(b.margin.missingFraction * 100)} % filled in) — tap its margin.`)
  const size = (m: MarginResult): number => {
    const c = centre(m)
    return m.points.reduce((s, p) => s + Math.hypot(...sub(p, c)), 0) / m.points.length
  }
  const [a, b] = size(best[0].margin) >= size(best[1].margin) ? [best[0].margin, best[1].margin] : [best[1].margin, best[0].margin]
  // a: the larger loop, to the tooth further back.
  const back = toothSide(teeth[0]).pos >= toothSide(teeth[1]).pos ? 0 : 1
  return back === 0 ? [a, b] : [b, a]
}

export async function designBridge(req: BridgeRequest): Promise<BridgeResult> {
  const notes: string[] = []
  const clearance = req.occlusalClearanceMm ?? 0.08
  const abut = req.units.filter((u) => u.role === 'abutment')
  const pons = req.units.filter((u) => u.role === 'pontic')
  if (abut.length !== 2 || pons.length !== 1) throw new Error('Bridges: two abutments and one pontic for now.')
  const pon = pons[0]
  const uni = (fdi: number): number => {
    const u = fdiToUniversal(fdi)
    if (!u) throw new Error(`bad tooth ${fdi}`)
    return u
  }
  const ant = req.antagonist
  const antIndex = ant ? new SurfaceIndex(ant) : null

  // 1. Margins (given, or found: the two clearest finish lines a span apart),
  // and one path of insertion both preps share.
  const pcs = abut.map((a) => prepareCase({ toothNumber: uni(a.fdi), prep: req.prep, antagonist: ant }))
  let margins: MarginResult[]
  if (abut.every((a) => a.margin && a.margin.length >= 4)) {
    margins = abut.map((a, k) => marginFromTaps(pcs[k].prepIndex, a.margin!, 180, antIndex ? { antagonist: antIndex } : undefined))
  } else {
    if (!antIndex) throw new Error('No opposing scan: tap both abutment margins.')
    margins = findAbutments(pcs[0].prepIndex, antIndex, abut.map((a) => uni(a.fdi)))
    notes.push('abutment margins found automatically')
  }
  const ax = commonAxis(pcs[0].prepWelded, margins.map((m) => m.points), margins[0].axis.up)
  notes.push(`common path of insertion: ${ax.tiltDeg.toFixed(0)}° from the mean margin normal, blockout ${ax.perAbutmentMm3.map((v) => v.toFixed(1)).join(' + ')} mm³`)

  // 2. Abutment crowns along it.
  const abutments = abut.map((a, k) => {
    const set = req.donors[toothClassOf(uni(a.fdi))]
    if (!set) throw new Error(`no donor set for #${a.fdi}`)
    const c = designFromDonors(pcs[k], { margin: margins[k], insertionAxis: ax.axis, params: { occlusalClearanceMm: clearance } }, set)
    if (!c) throw new Error(`#${a.fdi}: abutment design failed`)
    return { fdi: a.fdi, result: c.result, donor: c.donor }
  })

  // 3. Pontic frame: occlusal = the common axis, mesial toward the mesial abutment.
  const centroid = (pts: Vec3[]): Vec3 => scale(pts.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / pts.length)
  const mIdx = toothSide(uni(abut[0].fdi)).pos < toothSide(uni(abut[1].fdi)).pos ? 0 : 1
  let mesialAb = abutments[mIdx]
  let distalAb = abutments[1 - mIdx]
  const cM = centroid(margins[mIdx].points)
  const cD = centroid(margins[1 - mIdx].points)
  const up = normalize(ax.axis)
  let mes = sub(cM, cD)
  mes = normalize(sub(mes, scale(up, dot(mes, up))))
  const buc0 = cross(up, mes)
  // Buccal: away from the arch's inside — the side the abutments' own frames call buccal.
  const bucSign = Math.sign(dot(buc0, mesialAb.result.frame.buccal) + dot(buc0, distalAb.result.frame.buccal)) || 1
  const buccal = scale(buc0, bucSign)
  const mid = scale(add(cM, cD), 0.5)
  const provisional: ToothFrame = { origin: mid, occlusal: up, mesial: mes, buccal }
  const crownPts = (r: DesignResult): Vec3[] => {
    const p = r.crown.getAttribute('position')
    const out: Vec3[] = []
    for (let i = 0; i < p.count; i += 2) out.push(toLocal(provisional, [p.getX(i), p.getY(i), p.getZ(i)]))
    return out
  }
  let pm = crownPts(mesialAb.result)
  let pd = crownPts(distalAb.result)
  for (const [ab, pts] of [[mesialAb, pm], [distalAb, pd]] as const) if (!pts.every((p) => p.every(Number.isFinite))) throw new Error(`#${ab.fdi}: the abutment design came out invalid — check its margin`)
  // An abutment with no opposing tooth and no neighbour to read its height
  // from (lab case086's #16: no lower molar on the scan) takes the lab's usual
  // crown height over the margin centre (the donors' median for its position).
  // On its own it came out 10.1 mm over the margin centre against the
  // technician's 6.0; levelling it with the other abutment overshot (the
  // technician's #16 stood 2.6 mm above their #14).
  {
    const blind = (r: DesignResult): boolean => r.outer.measures.biteProbes === 0 && r.outer.measures.ridgeSides === 0
    const topOverMargin = (r: DesignResult, m: Vec3[]): number => {
      const c = centroid(m)
      const p = r.crown.getAttribute('position')
      let top = -Infinity
      for (let i = 0; i < p.count; i++) {
        const d = sub([p.getX(i), p.getY(i), p.getZ(i)], c)
        const h = dot(d, up)
        if (Math.hypot(...sub(d, scale(up, h))) < 3.5) top = Math.max(top, h)
      }
      return top
    }
    for (const k of [0, 1] as const) {
      const ab = k === 0 ? mesialAb : distalAb
      if (!blind(ab.result)) continue
      const ai = abut.findIndex((a) => a.fdi === ab.fdi)
      const set = req.donors[toothClassOf(uni(ab.fdi))]!
      const posA = toothSide(uni(ab.fdi)).pos
      const same = set.donors.filter((d) => d.tooth !== undefined && toothSide(d.tooth).pos === posA)
      const hs = (same.length ? same : set.donors).map((d) => {
        const g = donorTemplate(d).grid
        let t = g.pole[1]
        for (let q = 1; q < g.pts.length; q += 3) t = Math.max(t, g.pts[q])
        return t
      }).sort((x, y) => x - y)
      const usual = hs[Math.floor(hs.length / 2)]
      const delta = usual - topOverMargin(ab.result, margins[ai].points)
      if (Math.abs(delta) < 0.3) continue
      const c = designFromDonors(pcs[ai], { margin: margins[ai], insertionAxis: ax.axis, params: { occlusalClearanceMm: clearance, heightOffsetMm: delta } }, set)
      if (!c) continue
      const redone = { fdi: ab.fdi, result: c.result, donor: c.donor }
      abutments[ai] = redone
      if (k === 0) {
        mesialAb = redone
        pm = crownPts(redone.result)
      } else {
        distalAb = redone
        pd = crownPts(redone.result)
      }
      notes.push(`#${ab.fdi} has no bite or neighbour to set its height: set to the lab's usual ${usual.toFixed(1)} mm over the margin centre (${delta >= 0 ? '+' : ''}${delta.toFixed(1)} mm)`)
    }
  }
  const topOf = (pts: Vec3[]): number => Math.max(...pts.map((p) => p[1]))
  // The lower abutment sets the height: a tall one (case086's #16) put the pontic 4 mm into the bite.
  const targetTop = Math.min(topOf(pm), topOf(pd))
  const zc = (centroid(pm)[2] + centroid(pd)[2]) / 2
  // Coarse span (crowns' extreme points) for cropping the ridge; refined below at contact height.
  const xM0 = Math.min(...pm.map((p) => p[0]))
  const xD0 = Math.max(...pd.map((p) => p[0]))
  const gap0 = xM0 - xD0
  const xc0 = (xM0 + xD0) / 2

  // Ridge under the gap (the prep scan, in the pontic frame).
  const jawLocal = (() => {
    const p = pcs[0].prepWelded.getAttribute('position')
    const ix = pcs[0].prepWelded.index!
    const pos: number[] = []
    const idx: number[] = []
    const map = new Map<number, number>()
    for (let t = 0; t < ix.count; t += 3) {
      const v = [ix.getX(t), ix.getX(t + 1), ix.getX(t + 2)]
      const q = v.map((k) => toLocal(provisional, [p.getX(k), p.getY(k), p.getZ(k)]))
      if (q.every((c) => Math.abs(c[0] - xc0) > gap0 / 2 + 4 || Math.abs(c[2] - zc) > 9)) continue
      for (let k = 0; k < 3; k++) {
        if (!map.has(v[k])) {
          map.set(v[k], pos.length / 3)
          pos.push(...q[k])
        }
        idx.push(map.get(v[k])!)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3))
    g.setIndex(idx)
    return new SurfaceIndex(g)
  })()
  const ridgeAt = (x: number, z: number): number | null => jawLocal.raycast([x, targetTop + 15, z], [0, -1, 0], 0, 40)?.point[1] ?? null
  const ridgeC = ridgeAt(xc0, zc)
  if (ridgeC === null) throw new Error(`no ridge found under the pontic (span ${xD0.toFixed(1)}..${xM0.toFixed(1)} mm, z ${zc.toFixed(1)}, top ${targetTop.toFixed(1)})`)
  // The space at contact height (2 mm over the ridge to 1 mm under the crowns'
  // tops): a crown's widest point can sit low, and measuring from it left a
  // pontic short of a premolar abutment (lab case086: a 1.4 mm² neck).
  const band = (pts: Vec3[]): Vec3[] => {
    const lo = ridgeC + 2
    const hi = topOf(pts) - 1
    const b = pts.filter((p) => p[1] > lo && p[1] < hi && Math.abs(p[2] - zc) < 3.5)
    return b.length > 20 ? b : pts
  }
  const xM = Math.min(...band(pm).map((p) => p[0]))
  const xD = Math.max(...band(pd).map((p) => p[0]))
  const gap = xM - xD
  if (gap < 4) throw new Error(`pontic space ${gap.toFixed(1)} mm is too short`)
  const xc = (xM + xD) / 2
  const ridge0 = ridgeAt(xc, zc) ?? ridgeC

  // Donor for the pontic: its own position first, closest in length to the gap.
  const pUni = uni(pon.fdi)
  const pset = req.donors[toothClassOf(pUni)]
  if (!pset) throw new Error(`no donor set for pontic #${pon.fdi}`)
  const pos = toothSide(pUni).pos
  const pool = pset.donors.filter((d) => d.tooth !== undefined && toothSide(d.tooth).pos === pos)
  const cands = (pool.length ? pool : pset.donors).map((d) => ({ d, t: donorTemplate(d) }))
  const widthOf = (g: CrownGrid): number => {
    let lo = Infinity
    let hi = -Infinity
    for (let k = 0; k < g.pts.length; k += 3) {
      lo = Math.min(lo, g.pts[k])
      hi = Math.max(hi, g.pts[k])
    }
    return hi - lo
  }
  // Among donors within 1 mm of the space, the one with the most cusp relief:
  // by width alone the molar pontics came out 28 % flatter than the
  // technician's (1.45 vs 2.03 mm on cases 018, 029). The bite step only
  // carves; it can't add the anatomy back.
  cands.sort((a, b) => Math.abs(widthOf(a.t.grid) - gap) - Math.abs(widthOf(b.t.grid) - gap))
  const fits = cands.filter((c) => Math.abs(widthOf(c.t.grid) - gap) <= Math.abs(widthOf(cands[0].t.grid) - gap) + 1)
  const donor = fits.reduce((a, b) => (occlusalRelief(b.t.grid) > occlusalRelief(a.t.grid) ? b : a))
  const tg = donor.t.grid
  const Wt = widthOf(tg)
  // 0.2 mm into each abutment at the contact: held short, the connectors
  // showed as bare stubs between the units. The connectors are long enough to
  // cover the whole overlap, so it can't enclose a tunnel (case066).
  const sx = (gap + 0.4) / Wt
  const sz = sx * 0.97 // the technician's pontics cover the ridge buccally
  // Height of contour: the widest row in the lower 60 %.
  const radius = (j: number): number => rowOf(tg, j).reduce((s, p) => s + Math.hypot(p[0], p[2]), 0) / tg.nu
  let jh = 1
  for (let j = 1; j < Math.floor(tg.nv * 0.6); j++) if (radius(j) > radius(jh)) jh = j
  const tTop = Math.max(...Array.from({ length: tg.nv * tg.nu }, (_, k) => tg.pts[3 * k + 1]), tg.pole[1])
  const yh0 = rowOf(tg, jh).reduce((s, p) => s + p[1], 0) / tg.nu
  let lift = targetTop - (tTop - yh0) * sx // where the contour row lands
  const placeUp = (p: Vec3): Vec3 => [p[0] * sx + xc, (p[1] - yh0) * sx + lift, p[2] * sz + zc]
  // Down to the bite when it is far above it; never with the contour under 2.5 mm over the ridge.
  const antLocalIdx = antIndex
    ? (() => {
        const g = ant!.clone()
        const p = g.getAttribute('position')
        for (let i = 0; i < p.count; i++) {
          const q = toLocal(provisional, [p.getX(i), p.getY(i), p.getZ(i)])
          p.setXYZ(i, q[0], q[1], q[2])
        }
        return new SurfaceIndex(g)
      })()
    : null
  if (antLocalIdx) {
    let over = -Infinity
    for (let j = jh; j < tg.nv; j++) for (const p of rowOf(tg, j)) over = Math.max(over, clearance - antLocalIdx.gapUp(placeUp(p), 6))
    // Up to 1 mm the bite step carves locally, as the technician does (lowering
    // the whole pontic moved it 0.06 mm further from theirs); beyond, it drops.
    const drop = Math.min(Math.max(0, over - 1), Math.max(0, lift - (ridge0 + 2.5)))
    if (drop > 0.05) {
      lift -= drop
      notes.push(`pontic lowered ${drop.toFixed(2)} mm to the bite`)
    }
  }
  const upper: Vec3[][] = []
  for (let j = jh; j < tg.nv; j++) upper.push(rowOf(tg, j).map(placeUp))
  let topPole = placeUp(tg.pole)
  if (lift - ridge0 < 2) notes.push(`pontic contour only ${(lift - ridge0).toFixed(1)} mm over the ridge — short span height`)

  // 4. Bite: relieve the pontic's occlusal table from the antagonist.
  if (antLocalIdx) {
    const antLocal = antLocalIdx
    const nr = upper.length
    const deficit = upper.map((r) => r.map((p) => Math.max(0, clearance - antLocal.gapUp(p, 3))))
    for (let pass = 0; pass < 4; pass++) {
      const next = deficit.map((r, k) => r.map((d, i) => {
        let s = 0
        let n = 0
        for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
          const kk = k + dk
          if (kk < 0 || kk >= nr) continue
          s += deficit[kk][(i + di + tg.nu) % tg.nu]
          n++
        }
        return Math.max(d, s / n)
      }))
      for (let k = 0; k < nr; k++) deficit[k] = next[k]
    }
    let maxD = 0
    for (let k = 0; k < nr; k++) {
      const w = Math.min(1, k / 4) // the contour row stays put
      for (let i = 0; i < tg.nu; i++) {
        const d = deficit[k][i] * w
        maxD = Math.max(maxD, d)
        upper[k][i] = [upper[k][i][0], upper[k][i][1] - d, upper[k][i][2]]
      }
    }
    const dp = Math.max(0, clearance - antLocal.gapUp(topPole, 3))
    topPole = [topPole[0], topPole[1] - dp, topPole[2]]
    if (maxD > 0) notes.push(`pontic relieved up to ${maxD.toFixed(2)} mm from the antagonist`)
  }

  // 5. Base onto the ridge: a contact patch (rings inside half the contour),
  // then a convex transition up to the contour row, clearing toward the embrasures.
  const contour = upper[0]
  const patchRings = 4
  const transRows = 14
  const rings: Vec3[][] = []
  // Contact patch: 65 % of the contour. At half, our bases touched the ridge
  // over 32–41 % of their area against the technician's 40–64 % (median gap
  // 0.19–0.57 mm vs 0.07–0.17).
  const FP = 0.65
  for (let k = 1; k <= patchRings; k++) {
    const f = (FP * k) / patchRings
    rings.push(contour.map((p) => {
      const x = xc + (p[0] - xc) * f
      const z = zc + (p[2] - zc) * f
      return [x, ridgeAt(x, z) ?? ridge0, z] as Vec3
    }))
  }
  for (let k = 1; k <= transRows; k++) {
    // A quarter ellipse from the patch edge to the contour: a rounded, convex
    // base (a straight blend read as a cylinder), lifting off toward the embrasures.
    const t = k / (transRows + 1)
    const f = FP + (1 - FP) * Math.sin((t * Math.PI) / 2)
    const e = 1 - Math.cos((t * Math.PI) / 2)
    rings.push(contour.map((p) => {
      const x = xc + (p[0] - xc) * f
      const z = zc + (p[2] - zc) * f
      const r = ridgeAt(x, z) ?? ridge0
      const r0 = ridgeAt(xc + (p[0] - xc) * FP, zc + (p[2] - zc) * FP) ?? ridge0
      const y = Math.max(r + 0.3 * t * t, r0 + (p[1] - r0) * e)
      return [x, Math.min(y, p[1] - 0.05 * (1 - t)), z] as Vec3
    }))
  }
  // Open embrasures under the connectors: the gum rises toward each abutment
  // (the papilla) and the pontic's proximal thirds sank into it (lab case018:
  // 0.0 mm under ours, 1.7 under the technician's). Lifted to ≥ 1.5 mm over
  // the gum there, fading out toward the contact patch; never above the row over it.
  {
    const all = [...rings, ...upper]
    for (let k = 0; k < all.length; k++) {
      for (let i = 0; i < all[k].length; i++) {
        const p = all[k][i]
        const px = Math.abs(p[0] - xc) / (gap / 2)
        const want = EMBRASURE_MM * smoothstep(0.55, 0.9, px)
        if (want <= 0) continue
        const r = ridgeAt(p[0], p[2])
        if (r === null || p[1] >= r + want) continue
        const cap = k + 1 < all.length ? all[k + 1][i][1] - 0.05 : p[1]
        all[k][i] = [p[0], Math.min(r + want, Math.max(p[1], cap)), p[2]]
      }
    }
  }
  const bottom: Vec3 = [xc, ridgeAt(xc, zc) ?? ridge0, zc]
  const ponticLocal = ringsToMesh(bottom, [...rings, ...upper], topPole)
  const ponticWorld = ponticLocal.positions.slice()
  for (let k = 0; k < ponticWorld.length; k += 3) {
    const q = toWorld(provisional, [ponticWorld[k], ponticWorld[k + 1], ponticWorld[k + 2]])
    ponticWorld[k] = q[0]
    ponticWorld[k + 1] = q[1]
    ponticWorld[k + 2] = q[2]
  }

  // 6. Connectors: ellipsoids across each proximal plane.
  const w = await manifold()
  const anyMolar = req.units.some((u) => toothClassOf(uni(u.fdi)).endsWith('Molar'))
  const target = req.connectorMm2 ?? (anyMolar ? 12 : 9)
  const connectors: ConnectorReport[] = []
  const connectorSolids: Array<InstanceType<Wasm['Manifold']>> = []
  const connectorBoxes: Array<{ x: number; y: number; h: number; wdt: number }> = []
  for (const [xPlane, ab] of [[xM, mesialAb], [xD, distalAb]] as const) {
    // Vertical room at this plane: ridge + 1.5 mm (cleansable embrasure) up to 1 mm under the marginal ridge.
    // The gum read 1.5 mm in on the pontic side: straight down from the crown's
    // face the ray met the abutment's prep, and connectors landed over the teeth.
    const inward = xPlane > xc ? -1.5 : 1.5
    const lo = Math.min(ridgeAt(xPlane + inward, zc) ?? ridge0, ridge0 + 1) + 1.5
    const hi = targetTop - 1.8
    // Sized 6 % over: with the pontic short of the crowns the ellipse alone is the
    // narrowest section, and the mesh's facets cut a little off its area.
    const sized = target * CONNECTOR_OVERSIZE
    let H = Math.sqrt((4 * sized * 1.2) / Math.PI) // height:width = 1.2
    let W = (4 * sized) / (Math.PI * H)
    if (H > hi - lo) {
      H = Math.max(2, hi - lo)
      W = (4 * sized) / (Math.PI * H)
      notes.push(`connector #${ab.fdi}–#${pon.fdi}: ${H.toFixed(1)} mm of height available, widened to ${W.toFixed(1)} mm`)
    }
    let yc = Math.min(hi - H / 2, Math.max(lo + H / 2, (lo + hi) / 2 + 0.3))
    const e = w.Manifold.sphere(1, 48).scale([CONNECTOR_HALF_LENGTH_MM, H / 2, W / 2])
    const m = e.getMesh()
    // The exposed half: the one over the pontic side (the other runs inside the crown).
    const towardPontic = xPlane > xc ? -1 : 1
    let sH = 1
    const local = (): Vec3[] => {
      const out: Vec3[] = []
      for (let k = 0; k < m.vertProperties.length; k += 3) out.push([m.vertProperties[k] + xPlane, m.vertProperties[k + 1] * sH + yc, m.vertProperties[k + 2] + zc])
      return out
    }
    const exposed = (p: Vec3): boolean => (p[0] - xPlane) * towardPontic >= 0
    const biteGap = (): number | null => {
      if (!antLocalIdx) return null
      let g = Infinity
      for (const p of local()) if (p[1] > yc && exposed(p)) g = Math.min(g, antLocalIdx.gapUp(p, 3))
      return Number.isFinite(g) ? g : null
    }
    // Clear of the opposing teeth: down into the room below if there is any,
    // then shorter — the technician's 6–8 mm² connectors where the bite left
    // ~2 mm of height (case066) — but not under 6 mm².
    const b0 = biteGap()
    if (b0 !== null && b0 < clearance) {
      const down = Math.min(clearance - b0, Math.max(0, yc - (H * sH) / 2 - lo))
      if (down > 0) yc -= down
      const Hmin = (4 * CONNECTOR_MIN_MM2 * CONNECTOR_OVERSIZE) / (Math.PI * W)
      for (let it = 0; it < 3; it++) {
        const b1 = biteGap()
        if (b1 === null || b1 >= clearance - 0.02) break
        const Hc = H * sH
        const Hn = Math.max(Hmin, Hc - (clearance - b1))
        if (Hn >= Hc - 1e-3) break
        yc -= (Hc - Hn) / 2
        sH = Hn / H
      }
    }
    const Hfin = H * sH
    let gum = Infinity
    for (const p of local()) {
      if (p[1] > yc || !exposed(p)) continue
      const r = ridgeAt(p[0], p[2])
      if (r !== null) gum = Math.min(gum, p[1] - r)
    }
    const bite = biteGap()
    const area = ((Math.PI / 4) * W * Hfin) / CONNECTOR_OVERSIZE
    if (bite !== null && bite < clearance - 0.02) notes.push(`connector #${ab.fdi}–#${pon.fdi} is ${(clearance - bite).toFixed(2)} mm into the bite${area <= CONNECTOR_MIN_MM2 + 0.1 ? ` at its ${CONNECTOR_MIN_MM2} mm² floor — the bite needs adjusting` : ''}`)
    if (area < 9 - 0.05) notes.push(`connector #${ab.fdi}–#${pon.fdi} reduced to ${area.toFixed(1)} mm² to clear the bite — under the 9 mm² zirconia guideline (the lab's own run 6–8 mm² in such spaces)`)
    if (Number.isFinite(gum) && gum < 1) notes.push(`connector #${ab.fdi}–#${pon.fdi} only ${gum.toFixed(1)} mm over the gum — tight to clean under`)
    const v = local().flatMap((p) => toWorld(provisional, p))
    // Through toSolid: the pontic frame is mirrored when buccal flips (case086),
    // which turned the ellipsoids inside out (−28 mm³) and left the units apart.
    connectorSolids.push(toSolid(w, v, m.triVerts))
    connectorBoxes.push({ x: xPlane, y: yc, h: Hfin, wdt: W })
    connectors.push({ between: [ab.fdi, pon.fdi], targetMm2: target, widthMm: W, heightMm: Hfin, gumClearanceMm: Number.isFinite(gum) ? gum : null, biteClearanceMm: bite })
  }

  // 7. Union, then the prep cavities cut back out.
  const crownSolid = (r: DesignResult) => {
    const s = r.solidLocal
    const pw = new Float32Array(s.positions.length)
    for (let k = 0; k < s.positions.length; k += 3) pw.set(toWorld(r.frame, [s.positions[k], s.positions[k + 1], s.positions[k + 2]]), k)
    return toSolid(w, pw, s.indices)
  }
  const cavity = (r: DesignResult) => {
    // The intaglio closed at the margin and carried 4 mm down the root.
    // Grown 0.015 mm away from the axis: subtracting a surface that coincides
    // with the crown's own intaglio left thousands of sliver tunnels (genus
    // 3060 on lab case018); 0.015 mm more cement space is below what a mill holds.
    const g = r.intaglio.grid
    const ref: Vec3 = [0, g.pole[1] * 0.3, 0]
    const grow = (p: Vec3): Vec3 => add(p, scale(normalize(sub(p, ref)), CAVITY_GROW_MM))
    const rows: Vec3[][] = []
    rows.push(rowOf(g, 0).map((p) => grow([p[0], p[1] - 4, p[2]] as Vec3)))
    for (let j = 0; j < g.nv; j++) rows.push(rowOf(g, j).map(grow))
    const c = rows[0].reduce((s, p) => add(s, p), [0, 0, 0] as Vec3)
    const mesh = ringsToMesh(scale(c, 1 / rows[0].length), rows, grow(g.pole))
    const pw = mesh.positions.slice()
    for (let k = 0; k < pw.length; k += 3) {
      const q = toWorld(r.frame, [pw[k], pw[k + 1], pw[k + 2]])
      pw[k] = q[0]
      pw[k + 1] = q[1]
      pw[k + 2] = q[2]
    }
    return toSolid(w, pw, mesh.indices)
  }
  // The cavities come out of the added pieces only: the crowns' own intaglios
  // don't match the cavity grid exactly (0.8–1.3 mm³ of overlap on case018),
  // and cutting them shredded the fitting surface (genus 2183). A connector did
  // reach into a cavity (4.7 mm³), so the added pieces must be cut.
  const cavities = w.Manifold.union([cavity(mesialAb.result), cavity(distalAb.result)])
  const added = w.Manifold.union([toSolid(w, ponticWorld, ponticLocal.indices), ...connectorSolids]).subtract(cavities)
  let solid = w.Manifold.union([crownSolid(mesialAb.result), crownSolid(distalAb.result), added])
  // A tunnel left at a joint (where pontic and crown touch above and below
  // the connector — case018 on found margins): each joint filled with the
  // convex hull of what the bridge has there, within a slab the connector's
  // size. A hull has no holes; the cavities come out of it again.
  if (solid.genus() > 0) {
    const fills = connectorBoxes.map((b) => {
      // Up to 1.5 mm over the connector and 1 mm under it: the loop ran between
      // the connector and the contact above it.
      const box = w.Manifold.cube([2 * CONNECTOR_HALF_LENGTH_MM, b.h + 2.5, b.wdt], true).translate([0, 0.25, 0])
      const m = box.getMesh()
      const v = Array.from(m.vertProperties)
      const pts: Vec3[] = []
      for (let k = 0; k < v.length; k += 3) pts.push([v[k] + b.x, v[k + 1] + b.y, v[k + 2] + zc])
      const slab = toSolid(w, pts.flatMap((q) => toWorld(provisional, q)), m.triVerts)
      return solid.intersect(slab).hull().subtract(cavities)
    })
    const filled = w.Manifold.union([solid, ...fills])
    if (filled.genus() < solid.genus()) {
      notes.push(`joint tunnel closed (genus ${solid.genus()} → ${filled.genus()})`)
      solid = filled
    }
  }
  // Slivers of connector left in the cement space float free: keep the bridge itself.
  const bodies = solid.decompose().sort((a, b) => b.volume() - a.volume())
  let looseMm3 = 0
  if (bodies.length > 1) {
    looseMm3 = bodies.slice(1).reduce((v, b) => v + b.volume(), 0)
    notes.push(`${bodies.length - 1} loose fragment(s) dropped (${looseMm3.toFixed(3)} mm³)`)
    solid = bodies[0]
  }
  const out = solid.getMesh()
  const status = solid.status()
  const manifoldOk = String(status) === 'NoError' || (status as unknown as { value?: number })?.value === 0
  const blockers: string[] = []
  if (!manifoldOk) blockers.push('the solid is not watertight')
  if (solid.genus() !== 0) blockers.push(`the solid has ${solid.genus() > 0 ? `${solid.genus()} tunnel(s)` : 'separate pieces'} through it`)
  if (looseMm3 > 0.5) blockers.push(`part of the bridge came apart (${looseMm3.toFixed(1)} mm³) — a unit is not joined`)
  for (const k of connectors) {
    const area = (Math.PI / 4) * k.widthMm * k.heightMm / CONNECTOR_OVERSIZE
    if (area < CONNECTOR_MIN_MM2 - 0.05) blockers.push(`connector #${k.between[0]}–#${k.between[1]} only ${area.toFixed(1)} mm²`)
    if (k.biteClearanceMm !== null && k.biteClearanceMm < clearance - 0.05) blockers.push(`connector #${k.between[0]}–#${k.between[1]} ${(clearance - k.biteClearanceMm).toFixed(2)} mm into the bite`)
  }
  for (const a of abutments) {
    for (const x of a.result.report.results) if (x.verdict === 'fail' && !x.id.startsWith('contact')) blockers.push(`#${a.fdi}: ${x.label} ${x.measured}`)
  }
  return {
    positions: Float32Array.from(out.vertProperties),
    indices: Uint32Array.from(out.triVerts),
    manifoldOk,
    genus: solid.genus(),
    volumeMm3: solid.volume(),
    axis: ax.axis,
    axisBlockoutMm3: ax.perAbutmentMm3,
    abutments,
    pontic: { fdi: pon.fdi, donor: donor.d.id, frame: { ...provisional, origin: toWorld(provisional, [xc, ridge0, zc]) }, gapMm: gap },
    connectors,
    blockers,
    notes
  }
}
