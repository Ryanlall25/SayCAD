/**
 * Where does the anatomy go wrong? Runs the engine on the technician's margin
 * for each lab case and measures the outer surface after every design stage
 * against the technician's crown, in the tooth frame:
 *
 *   npm run anatomy -- dev/cases/pick
 *
 * Bands (by grid row): cervical (lowest 30 %), middle, occlusal (top 30 %).
 * Side bands compare the radius from the tooth axis (+ = ours fuller);
 * the occlusal band compares height (+ = ours higher). "relief" is the spread
 * of occlusal heights (cusp tips vs fossae): how deep the anatomy is.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { SurfaceIndex, toLocal, type Vec3 } from '../src/crown/geom'
import type { CrownGrid } from '../src/crown/grid'
import { designCase } from '../src/module'
import { fdiToUniversal } from '../src/crown/library'
import { trainShapeModel } from '../src/crown/ssm'
import { analyseCase } from '../src/crown/train'
import { toothClassOf } from '../src/crown/anatomy'
import { listCases, loadLabCase } from './lib/labCases'

const args = process.argv.slice(2).filter((a) => a !== '--')
const root = args.find((a) => !a.startsWith('--')) ?? 'dev/cases/pick'
const anatomy: Record<string, string> = {}
for (const f of existsSync('public/models') ? readdirSync('public/models') : []) {
  const m = /^ssm-(\w+)\.json$/.exec(f)
  if (m) anatomy[m[1]] = readFileSync(join('public/models', f), 'utf8')
  const t = /^lib-round-t(\d+)\.json$/.exec(f)
  if (t) anatomy[`t${t[1]}`] = readFileSync(join('public/models', f), 'utf8')
}
const mean = (x: number[]): number => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : NaN)
const f2 = (x: number): string => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '  —  ')

// --self: start from the case's OWN technician crown — the ceiling: whatever is
// lost is lost by the design steps, not by the choice of starting anatomy.
// --donors: start from the lab's other crowns (public/models/donors-*.json).
const summary: Array<{ id: string; all: number; occ: number; relief: number; fails: string[] }> = []
const self = args.includes('--self')
const pi = args.indexOf('--params')
const params = pi >= 0 ? JSON.parse(args[pi + 1]) : undefined
const donorFiles = args.includes('--donors') && existsSync('public/models') ? readdirSync('public/models').filter((f) => /^donors-\w+\.json$/.test(f)) : []
for (const c of listCases(root)) {
  const lc = loadLabCase(root, c)
  const dir = lc.dir
  const info = { fdi_tooth: lc.fdi, margin_points: lc.margin }
  if (!lc.antagonist) continue
  let caseAnatomy = anatomy
  if (self) {
    const a = analyseCase({ id: c, toothNumber: fdiToUniversal(lc.fdi)!, prep: lc.prepGeometry, crown: lc.crown, margin: lc.margin })
    if (!a.ok || !a.shape) { console.log(c, 'skip:', a.error); continue }
    // As a one-crown donor set, so the template keeps the crown's real proportions.
    caseAnatomy = { [`donors-${toothClassOf(fdiToUniversal(lc.fdi)!)}`]: JSON.stringify({ version: 1, cls: a.cls, donors: [{ id: c, model: trainShapeModel(a.cls, [a.shape]), size: a.size }] }) }
  } else if (donorFiles.length) {
    caseAnatomy = { ...anatomy }
    for (const f of donorFiles) {
      const set = JSON.parse(readFileSync(join('public/models', f), 'utf8')) as { donors: Array<{ id: string }> }
      caseAnatomy[f.replace(/\.json$/, '')] = JSON.stringify({ ...set, donors: set.donors.filter((d) => d.id !== c) })
    }
  }
  const stages: Array<[string, CrownGrid]> = []
  const out = designCase(
    { contract: 'saycad.crown/1', jobId: c, order: { tooth: info.fdi_tooth, system: 'fdi', material: 'zirconia-hs' }, scans: { prep: lc.prep, antagonist: lc.antagonist }, options: { anatomy: caseAnatomy, margin: info.margin_points, ...(params ? { params } : {}) } } as Parameters<typeof designCase>[0],
    { onStage: (s, g) => stages.push([s, { ...g, pts: g.pts.slice(), pole: [...g.pole] as Vec3 }]) }
  )
  const frame = out.files?.designRecord?.frame
  if (!frame) {
    console.log(c, 'no design:', out.status, out.error ?? out.needs?.map((n) => n.message).join(' | '))
    continue
  }
  // The technician's crown in the tooth frame.
  const tg = lc.crown.clone()
  const tp = tg.getAttribute('position')
  for (let i = 0; i < tp.count; i++) {
    const q = toLocal(frame, [tp.getX(i), tp.getY(i), tp.getZ(i)])
    tp.setXYZ(i, q[0], q[1], q[2])
  }
  const tech = new SurfaceIndex(tg as THREE.BufferGeometry)
  if (args.includes('--verify')) {
    // The final grid against our own exported crown, in the same frame: should be ~0.
    const og = new STLLoader().parse(out.files!.crownStl!)
    const op = og.getAttribute('position')
    for (let i = 0; i < op.count; i++) {
      const q = toLocal(frame, [op.getX(i), op.getY(i), op.getZ(i)])
      op.setXYZ(i, q[0], q[1], q[2])
    }
    const ours = new SurfaceIndex(og as THREE.BufferGeometry)
    const g = stages[stages.length - 1][1]
    const d: number[] = []
    for (let k = 0; k < g.pts.length; k += 3) d.push(ours.closest([g.pts[k], g.pts[k + 1], g.pts[k + 2]], 20)?.distance ?? 20)
    const b = (gg: THREE.BufferGeometry) => { gg.computeBoundingBox(); const x = gg.boundingBox!; return `${x.min.toArray().map((v) => v.toFixed(1))} .. ${x.max.toArray().map((v) => v.toFixed(1))}` }
    console.log(c, 'grid→our STL mean', mean(d).toFixed(3), 'ours bbox', b(og), 'tech bbox', b(tg))
  }
  // Signed distance to the technician's surface: + where ours is outside theirs.
  const signed = (p: Vec3): number | null => {
    const h = tech.closest(p, 6)
    if (!h) return null
    const n = tech.faceNormal(h.faceIndex)
    const d: Vec3 = [p[0] - h.point[0], p[1] - h.point[1], p[2] - h.point[2]]
    return Math.sign(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) * h.distance
  }
  const outerY = (p: Vec3): number | null => tech.raycast([p[0], 40, p[2]], [0, -1, 0], 0, 60)?.point[1] ?? null
  if (args.includes('--size')) {
    // Size and position of the placed crown vs the technician's, tooth frame (mm).
    const box = (xs: number[][]) => { const mn = [Infinity, Infinity, Infinity]; const mx = [-Infinity, -Infinity, -Infinity]; for (const p of xs) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]) } return { mn, mx, d: mx.map((v, k) => v - mn[k]), c: mx.map((v, k) => (v + mn[k]) / 2) } }
    const tpts: number[][] = []
    const tq = tg.getAttribute('position')
    for (let i = 0; i < tq.count; i++) tpts.push([tq.getX(i), tq.getY(i), tq.getZ(i)])
    const T = box(tpts)
    const M = box(lc.margin.map((m) => toLocal(frame, m)))
    console.log(`${c} margin  MD ${M.d[0].toFixed(2)} BL ${M.d[2].toFixed(2)} | technician MD-margin ${(T.d[0] - M.d[0]).toFixed(2)} BL-margin ${(T.d[2] - M.d[2]).toFixed(2)} BL/MD ${(T.d[2] / T.d[0]).toFixed(3)}`)
    for (const [name, g] of stages.filter(([n]) => n === 'placed' || n === 'final')) {
      const gp: number[][] = []
      for (let k = 0; k < g.pts.length; k += 3) gp.push([g.pts[k], g.pts[k + 1], g.pts[k + 2]])
      const O = box(gp)
      console.log(`${c} ${name.padEnd(7)} MD ${O.d[0].toFixed(2)} vs ${T.d[0].toFixed(2)} | BL ${O.d[2].toFixed(2)} vs ${T.d[2].toFixed(2)} | top ${O.mx[1].toFixed(2)} vs ${T.mx[1].toFixed(2)} | centre x ${O.c[0].toFixed(2)} vs ${T.c[0].toFixed(2)}, z ${O.c[2].toFixed(2)} vs ${T.c[2].toFixed(2)}`)
    }
  }
  console.log(`\n${c} #${info.fdi_tooth}  (mm, signed distance to the technician's crown: + = ours outside theirs)`)
  console.log('stage        cervical  middle   occlusal | |cerv|  |mid|  |occ| | relief ours/tech')
  for (const [name, g] of stages) {
    const cerv: number[] = []
    const mid: number[] = []
    const occ: number[] = []
    const hOurs: number[] = []
    const hTech: number[] = []
    for (let j = 1; j < g.nv; j++) {
      const t = j / g.nv
      for (let i = 0; i < g.nu; i++) {
        const k = (j * g.nu + i) * 3
        const p: Vec3 = [g.pts[k], g.pts[k + 1], g.pts[k + 2]]
        const sd = signed(p)
        if (sd !== null) (t < 0.3 ? cerv : t < 0.7 ? mid : occ).push(sd)
        if (t >= 0.7) {
          const y = outerY(p)
          if (y !== null) {
            hOurs.push(p[1])
            hTech.push(y)
          }
        }
      }
    }
    const spread = (h: number[]): number => {
      const s = [...h].sort((a, b) => a - b)
      return s.length ? s[Math.floor(s.length * 0.95)] - s[Math.floor(s.length * 0.05)] : NaN
    }
    const abs = (x: number[]): number => mean(x.map(Math.abs))
    console.log(`${name.padEnd(12)} ${f2(mean(cerv)).padStart(7)}  ${f2(mean(mid)).padStart(6)}   ${f2(mean(occ)).padStart(6)}  | ${abs(cerv).toFixed(2)}   ${abs(mid).toFixed(2)}   ${abs(occ).toFixed(2)} | ${spread(hOurs).toFixed(2)} / ${spread(hTech).toFixed(2)}`)
    if (name === 'final') {
      const all = [...cerv, ...mid, ...occ]
      summary.push({ id: c, all: abs(all), occ: abs(occ), relief: Math.abs(spread(hOurs) - spread(hTech)), fails: (out.checks ?? []).filter((x) => x.verdict === 'fail').map((x) => x.id) })
    }
  }
}
if (summary.length) {
  console.log('\nSUMMARY (final)  surface |dist| all / occlusal, |relief error|, fails')
  for (const r of summary) console.log(`  ${r.id.padEnd(8)} ${r.all.toFixed(3)} / ${r.occ.toFixed(3)}  relief ${r.relief.toFixed(2)}  ${r.fails.join(',')}`)
  const m = (k: 'all' | 'occ' | 'relief'): string => mean(summary.map((r) => r[k])).toFixed(3)
  console.log(`  MEAN     ${m('all')} / ${m('occ')}  relief ${m('relief')}  fails ${summary.filter((r) => r.fails.length).length}/${summary.length}`)
}
