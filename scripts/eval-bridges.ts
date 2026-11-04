/**
 * Bridges against the lab's own (dev): designs each 3-unit bridge from the
 * technician's margins and compares it with the technician's bridge.
 *
 *   npx vite-node scripts/eval-bridges.ts -- dev/cases/exo90/r case018 case029 …
 *
 * Writes <case>/out/bridge-saycad.stl. Reports surface distance both ways,
 * connector cross-sections (sliced along the abutment line), the pontic base
 * gap to the ridge, and whether the solid is manifold.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { parseScan } from '../src/core/meshConvert'
import { designBridge, type BridgeUnit } from '../src/crown/bridge'
import { parseDonorSet, type DonorSet } from '../src/crown/donors'
import type { ToothClass } from '../src/crown/anatomy'
import { SurfaceIndex, type Vec3 } from '../src/crown/geom'
import { ab } from './lib/labCases'

const args = process.argv.slice(2).filter((a) => a !== '--')
const root = args[0]
const ids = args.slice(1)
const donors: Partial<Record<ToothClass, DonorSet>> = {}
for (const f of readdirSync('public/models').filter((f) => /^donors-\w+\.json$/.test(f))) {
  const s = parseDonorSet(readFileSync(join('public/models', f), 'utf8'))
  if (s) donors[s.cls] = s
}
const dot = (a: number[], c: number[]): number => a[0] * c[0] + a[1] * c[1] + a[2] * c[2]
const cr = (a: number[], c: number[]): number[] => [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]]

/** Cross-section area of a closed mesh on the plane {p : (p − A)·u = s} (Green's theorem over cut segments). */
function section(P: THREE.BufferAttribute, A: number[], u: number[], s: number): number {
  const t0 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  let e1 = cr(u, t0)
  const l1 = Math.hypot(...e1)
  e1 = e1.map((x) => x / l1)
  const e2 = cr(u, e1)
  let area = 0
  for (let f = 0; f < P.count; f += 3) {
    const v = [0, 1, 2].map((q) => [P.getX(f + q) - A[0], P.getY(f + q) - A[1], P.getZ(f + q) - A[2]])
    const h = v.map((x) => dot(x, u) - s)
    const seg: number[][] = []
    for (let q = 0; q < 3; q++) {
      const a = v[q], c = v[(q + 1) % 3], ha = h[q], hc = h[(q + 1) % 3]
      if ((ha < 0) !== (hc < 0)) {
        const t = ha / (ha - hc)
        const p = [0, 1, 2].map((k) => a[k] + t * (c[k] - a[k]))
        seg.push([dot(p, e1), dot(p, e2)])
      }
    }
    if (seg.length !== 2) continue
    const n = cr([v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]], [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]])
    const n2 = [dot(n, e1), dot(n, e2)]
    let [p, q] = seg
    const d = [q[0] - p[0], q[1] - p[1]]
    if (d[1] * n2[0] - d[0] * n2[1] < 0) [p, q] = [q, p]
    area += 0.5 * (p[0] * q[1] - q[0] * p[1])
  }
  return Math.abs(area)
}

const nonIndexed = (positions: Float32Array, indices: Uint32Array): THREE.BufferGeometry => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setIndex(new THREE.BufferAttribute(indices, 1))
  return g.toNonIndexed()
}

for (const id of ids) {
  const dir = join(root, id)
  const info = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'))
  const units: BridgeUnit[] = info.restorations
    .filter((r: { type: string }) => r.type === 'AnatomicCrown' || r.type === 'AnatomicPontic')
    .map((r: { fdi: number; type: string; margin_points: Vec3[] }) => ({ fdi: r.fdi, role: r.type === 'AnatomicPontic' ? 'pontic' : 'abutment', margin: r.margin_points?.length ? r.margin_points : undefined }))
  const lower = units[0].fdi >= 30
  const jaw = parseScan('jaw.obj', ab(readFileSync(join(dir, lower ? 'lower_jaw.obj' : 'upper_jaw.obj'))))
  const opp = parseScan('opp.obj', ab(readFileSync(join(dir, lower ? 'upper_jaw.obj' : 'lower_jaw.obj'))))
  // Dies set in the jaw: the jaw's copy of each die area dropped (as scripts/lib/labCases).
  const dies = units.filter((u) => u.role === 'abutment').map((u) => join(dir, `die_${u.fdi}.obj`)).filter(existsSync).map((f) => parseScan(f, ab(readFileSync(f))))
  const near = dies.map((d) => new SurfaceIndex(d))
  const pos: number[] = []
  const idx: number[] = []
  const addG = (g: THREE.BufferGeometry, keep: (c: Vec3) => boolean): void => {
    const p = g.getAttribute('position')
    const ix = g.index!
    const base = pos.length / 3
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i))
    for (let t = 0; t < ix.count; t += 3) {
      const a = ix.getX(t), b = ix.getX(t + 1), c = ix.getX(t + 2)
      const cen: Vec3 = [(p.getX(a) + p.getX(b) + p.getX(c)) / 3, (p.getY(a) + p.getY(b) + p.getY(c)) / 3, (p.getZ(a) + p.getZ(b) + p.getZ(c)) / 3]
      if (keep(cen)) idx.push(base + a, base + b, base + c)
    }
  }
  addG(jaw, (c) => near.every((n) => !n.closest(c, 1.2)))
  for (const d of dies) addG(d, () => true)
  const prep = new THREE.BufferGeometry()
  prep.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3))
  prep.setIndex(idx)

  const t0 = performance.now()
  let r
  try {
    r = await designBridge({ prep, antagonist: opp, units, donors })
  } catch (e) {
    console.log(`${id}: FAILED — ${(e as Error).message}`)
    continue
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(0)
  mkdirSync(join(dir, 'out'), { recursive: true })
  const ours = nonIndexed(r.positions, r.indices)
  const stl = (g: THREE.BufferGeometry): Buffer => {
    const p = g.getAttribute('position')
    const n = p.count / 3
    const b = Buffer.alloc(84 + n * 50)
    b.writeUInt32LE(n, 80)
    for (let f = 0; f < n; f++) for (let k = 0; k < 9; k++) b.writeFloatLE(p.getX(f * 3 + Math.floor(k / 3)) * (k % 3 === 0 ? 1 : 0) + p.getY(f * 3 + Math.floor(k / 3)) * (k % 3 === 1 ? 1 : 0) + p.getZ(f * 3 + Math.floor(k / 3)) * (k % 3 === 2 ? 1 : 0), 84 + f * 50 + 12 + k * 4)
    return b
  }
  writeFileSync(join(dir, 'out', 'bridge-saycad.stl'), stl(ours))
  const techF = readdirSync(dir).find((f) => /bridge.*\.stl$/.test(f))!
  const tech = new STLLoader().parse(ab(readFileSync(join(dir, techF))))
  const T = new SurfaceIndex(tech)
  const O = new SurfaceIndex(ours)
  const dist = (from: THREE.BufferGeometry, to: SurfaceIndex): number[] => {
    const p = from.getAttribute('position')
    const d: number[] = []
    for (let i = 0; i < p.count; i += 7) d.push(to.closest([p.getX(i), p.getY(i), p.getZ(i)], 5)?.distance ?? 5)
    return d.sort((a, b) => a - b)
  }
  const mean = (x: number[]): number => x.reduce((a, b) => a + b, 0) / x.length
  const dOT = dist(ours, T)
  const dTO = dist(tech, O)
  // Connectors: minimum section between each abutment's margin and the gap middle.
  const abs = units.filter((u) => u.role === 'abutment')
  const cen = (pts: Vec3[]): number[] => [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length)
  const A = cen(abs[0].margin!)
  const B = cen(abs[1].margin!)
  const L = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2])
  const u = [0, 1, 2].map((k) => (B[k] - A[k]) / L)
  const along = (m: Vec3[]): number[] => m.map((p) => dot([p[0] - A[0], p[1] - A[1], p[2] - A[2]], u))
  const aEnd = Math.max(...along(abs[0].margin!))
  const bStart = Math.min(...along(abs[1].margin!))
  const conn = (g: THREE.BufferGeometry, lo: number, hi: number): number => {
    const P = g.getAttribute('position') as THREE.BufferAttribute
    let m = Infinity
    for (let s = lo; s <= hi; s += 0.1) m = Math.min(m, section(P, A, u, s))
    return m
  }
  const midS = (aEnd + bStart) / 2
  const oc = [conn(ours, aEnd, midS), conn(ours, midS, bStart)]
  const tc = [conn(tech, aEnd, midS), conn(tech, midS, bStart)]
  const fails = [...r.abutments.flatMap((a) => a.result.report.results.filter((x) => x.verdict === 'fail' && !x.id.startsWith('contact')).map((x) => `#${a.fdi} ${x.id}`))]
  console.log(`${id} ${units.map((x) => x.fdi + (x.role === 'pontic' ? 'p' : '')).join('-')} · ${secs} s · manifold ${r.manifoldOk ? 'ok' : 'BROKEN'} genus ${r.genus} · vs technician: ours→tech ${mean(dOT).toFixed(3)} mm (p90 ${dOT[Math.floor(dOT.length * 0.9)].toFixed(2)}), tech→ours ${mean(dTO).toFixed(3)} mm (p90 ${dTO[Math.floor(dTO.length * 0.9)].toFixed(2)})`)
  console.log(`    connectors ours ${oc.map((x) => x.toFixed(1)).join(' / ')} mm² · technician ${tc.map((x) => x.toFixed(1)).join(' / ')} mm² · pontic donor ${r.pontic.donor}, gap ${r.pontic.gapMm.toFixed(1)} mm · abutment donors ${r.abutments.map((a) => `#${a.fdi} ${a.donor}`).join(', ')}`)
  if (fails.length) console.log(`    abutment fails: ${fails.join(', ')}`)
  for (const n of r.notes) console.log(`    ${n}`)
  {
    const f = r.pontic.frame
    const loc = (g: THREE.BufferGeometry) => { const p = g.getAttribute('position'); const o: number[][] = []; for (let i = 0; i < p.count; i += 3) { const d = [p.getX(i) - f.origin[0], p.getY(i) - f.origin[1], p.getZ(i) - f.origin[2]]; o.push([dot(d, f.mesial), dot(d, f.occlusal), dot(d, f.buccal)]) } return o }
    const lt = loc(tech), lo = loc(ours)
    const tops = (pts: number[][]) => [[-99, -r.pontic.gapMm / 2], [-r.pontic.gapMm / 2, r.pontic.gapMm / 2], [r.pontic.gapMm / 2, 99]].map(([a, b]) => Math.max(...pts.filter((p) => p[0] > a && p[0] < b).map((p) => p[1])).toFixed(2))
    console.log(`    unit tops over the ridge (distal / pontic / mesial): ours ${tops(lo).join(' / ')} · technician ${tops(lt).join(' / ')}`)
  }
  for (const a of r.abutments) {
    const f = a.result.frame
    const near = (g: THREE.BufferGeometry, rad: number) => { const p = g.getAttribute('position'); let top = -Infinity; for (let i = 0; i < p.count; i++) { const d = [p.getX(i) - f.origin[0], p.getY(i) - f.origin[1], p.getZ(i) - f.origin[2]]; const x = dot(d, f.mesial), y = dot(d, f.occlusal), z = dot(d, f.buccal); if (Math.hypot(x, z) < rad) top = Math.max(top, y) } return top }
    console.log(`    #${a.fdi} height over its margin: ours ${a.result.outer.measures.heightMm.toFixed(2)} (top ${near(ours, 3).toFixed(2)}) · technician top ${near(tech, 3).toFixed(2)} · up·axis ${dot(a.result.margin.axis.up, r.axis).toFixed(2)}`)
  }
  if (process.env.BRIDGE_STEPS) for (const a of r.abutments) console.log(`    #${a.fdi} steps: ${a.result.outer.measures.steps.join(' | ')}`)
}
