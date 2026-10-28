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
import { parseScan } from '../src/core/meshConvert'

const args = process.argv.slice(2).filter((a) => a !== '--')
const root = args.find((a) => !a.startsWith('--')) ?? 'dev/cases/pick'
const anatomy: Record<string, string> = {}
for (const f of existsSync('public/models') ? readdirSync('public/models') : []) {
  const m = /^ssm-(\w+)\.json$/.exec(f)
  if (m) anatomy[m[1]] = readFileSync(join('public/models', f), 'utf8')
  const t = /^lib-round-t(\d+)\.json$/.exec(f)
  if (t) anatomy[`t${t[1]}`] = readFileSync(join('public/models', f), 'utf8')
}
const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const scan = (dir: string, f: string) => ({ name: f, data: ab(readFileSync(join(dir, f))) })

function prepWithDie(dir: string) {
  const jaw = parseScan('prep_jaw.obj', ab(readFileSync(join(dir, 'prep_jaw.obj'))))
  const die = parseScan('prep_die.obj', ab(readFileSync(join(dir, 'prep_die.obj'))))
  const near = new SurfaceIndex(die)
  const pos: number[] = []
  const idx: number[] = []
  for (const [g, all] of [[jaw, false], [die, true]] as const) {
    const p = g.getAttribute('position')
    const ix = g.index!
    const base = pos.length / 3
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i))
    for (let t = 0; t < ix.count; t += 3) {
      const a = ix.getX(t), b = ix.getX(t + 1), c = ix.getX(t + 2)
      const cen: Vec3 = [(p.getX(a) + p.getX(b) + p.getX(c)) / 3, (p.getY(a) + p.getY(b) + p.getY(c)) / 3, (p.getZ(a) + p.getZ(b) + p.getZ(c)) / 3]
      if (all || !near.closest(cen, 1.2)) idx.push(base + a, base + b, base + c)
    }
  }
  return { name: 'prep_jaw+die.obj', mesh: { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) } }
}

const mean = (x: number[]): number => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : NaN)
const f2 = (x: number): string => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '  —  ')

for (const c of readdirSync(root).filter((d) => /^case\d+$/.test(d)).sort()) {
  const dir = join(root, c)
  const info = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as { fdi_tooth: number; margin_points: Vec3[] }
  const stages: Array<[string, CrownGrid]> = []
  const out = designCase(
    { contract: 'saycad.crown/1', jobId: c, order: { tooth: info.fdi_tooth, system: 'fdi', material: 'zirconia-hs' }, scans: { prep: prepWithDie(dir), antagonist: scan(dir, 'opposing_jaw.obj') }, options: { anatomy, margin: info.margin_points } } as Parameters<typeof designCase>[0],
    { onStage: (s, g) => stages.push([s, { ...g, pts: g.pts.slice(), pole: [...g.pole] as Vec3 }]) }
  )
  const frame = out.files?.designRecord?.frame
  if (!frame) {
    console.log(c, 'no design:', out.status, out.error ?? out.needs?.map((n) => n.message).join(' | '))
    continue
  }
  // The technician's crown in the tooth frame.
  const tg = new STLLoader().parse(ab(readFileSync(join(dir, 'crown_exocad.stl'))))
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
  }
}
