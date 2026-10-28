/**
 * Which starting anatomy gets closest to the lab's own crowns? Leave-one-out
 * on finished lab cases of one tooth class (local only):
 *
 *   npm run anatomy-loo -- dev/cases/lm
 *
 * Every case with an antagonist is designed on the technician's margin
 * (isolating anatomy from margin finding) from:
 *   library — the bundled library tooth (today's default);
 *   mean    — a shape model trained on the OTHER cases' crowns;
 *   donor   — each other case's crown on its own (typical and best).
 * and scored against its own technician's crown: surface deviation (mm) and
 * occlusal relief (cusp-to-fossa height spread, mm) vs the technician's.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { SurfaceIndex, toLocal, type Vec3 } from '../src/crown/geom'
import type { CrownGrid } from '../src/crown/grid'
import { fdiToUniversal } from '../src/crown/library'
import { trainShapeModel, type ShapeModel } from '../src/crown/ssm'
import { analyseCase } from '../src/crown/train'
import { designCase } from '../src/module'
import { listCases, loadLabCase, type LabCase } from './lib/labCases'

const args = process.argv.slice(2).filter((a) => a !== '--')
const root = args.find((a) => !a.startsWith('--')) ?? 'dev/cases/lm'
const library: Record<string, string> = {}
for (const f of existsSync('public/models') ? readdirSync('public/models') : []) {
  const t = /^lib-round-t(\d+)\.json$/.exec(f)
  if (t) library[`t${t[1]}`] = readFileSync(join('public/models', f), 'utf8')
}

const cases = listCases(root).map((id) => loadLabCase(root, id))
console.log(`${cases.length} cases: ${cases.map((c) => `${c.id}#${c.fdi}`).join(' ')}`)
const shapes = new Map<string, CrownGrid>()
for (const c of cases) {
  const a = analyseCase({ id: c.id, toothNumber: fdiToUniversal(c.fdi)!, prep: c.prepGeometry, crown: c.crown })
  if (a.ok && a.shape) shapes.set(c.id, a.shape)
  else console.log(`  ${c.id}: not used for training (${a.error})`)
}

interface Score { dev: number; p90: number; reliefOurs: number; reliefTech: number; fails: string[] }
function score(c: LabCase, anatomy: Record<string, string>): Score | null {
  let finalGrid: CrownGrid | null = null
  const out = designCase(
    { contract: 'saycad.crown/1', jobId: c.id, order: { tooth: c.fdi, system: 'fdi', material: 'zirconia-hs' }, scans: { prep: c.prep, antagonist: c.antagonist! }, options: { anatomy, margin: c.margin } } as Parameters<typeof designCase>[0],
    { onStage: (s, g) => { if (s === 'final') finalGrid = g } }
  )
  const frame = out.files?.designRecord?.frame
  if (!frame || !out.files?.crownStl || !finalGrid) return null
  const truth = new SurfaceIndex(c.crown)
  const ours = new STLLoader().parse(out.files.crownStl).getAttribute('position')
  const d: number[] = []
  for (let i = 0; i < ours.count; i += 3) d.push(truth.closest([ours.getX(i), ours.getY(i), ours.getZ(i)], 10)?.distance ?? 10)
  d.sort((x, y) => x - y)
  // Occlusal relief in the tooth frame: spread of heights over the top 30 % of rows.
  const tg = c.crown.clone()
  const tp = tg.getAttribute('position')
  for (let i = 0; i < tp.count; i++) {
    const q = toLocal(frame, [tp.getX(i), tp.getY(i), tp.getZ(i)])
    tp.setXYZ(i, q[0], q[1], q[2])
  }
  const techLocal = new SurfaceIndex(tg as THREE.BufferGeometry)
  const g = finalGrid as CrownGrid
  const hO: number[] = []
  const hT: number[] = []
  for (let j = Math.ceil(g.nv * 0.7); j < g.nv; j++) {
    for (let i = 0; i < g.nu; i++) {
      const k = (j * g.nu + i) * 3
      const y = techLocal.raycast([g.pts[k], 40, g.pts[k + 2]], [0, -1, 0], 0, 60)?.point[1]
      if (y === undefined) continue
      hO.push(g.pts[k + 1])
      hT.push(y)
    }
  }
  const spread = (h: number[]): number => {
    const s = [...h].sort((a, b) => a - b)
    return s[Math.floor(s.length * 0.95)] - s[Math.floor(s.length * 0.05)]
  }
  return {
    dev: d.reduce((s, x) => s + x, 0) / d.length,
    p90: d[Math.floor(d.length * 0.9)],
    reliefOurs: spread(hO),
    reliefTech: spread(hT),
    fails: (out.checks ?? []).filter((x) => x.verdict === 'fail').map((x) => x.id)
  }
}

const modelJson = (m: ShapeModel): string => JSON.stringify(m)
const fmt = (s: Score | null): string => (s ? `${s.dev.toFixed(2)} / ${s.p90.toFixed(2)}  relief ${s.reliefOurs.toFixed(2)}${s.fails.length ? '  FAIL ' + s.fails.join(',') : ''}` : '—')
const rows: string[] = ['case,fdi,variant,dev_mean,dev_p90,relief_ours,relief_tech,fails']
const log = (c: LabCase, v: string, s: Score | null): void => {
  if (s) rows.push([c.id, c.fdi, v, s.dev.toFixed(3), s.p90.toFixed(3), s.reliefOurs.toFixed(3), s.reliefTech.toFixed(3), s.fails.join(' ')].join(','))
}
for (const c of cases) {
  if (!c.antagonist) continue
  const cls = 'lowerMolar'
  const others = [...shapes.entries()].filter(([id]) => id !== c.id)
  const lib = score(c, library)
  const mean = others.length >= 2 ? score(c, { [cls]: modelJson(trainShapeModel(cls, others.map(([, g]) => g))) }) : null
  const donors: Array<[string, Score]> = []
  for (const [id, g] of others) {
    const s = score(c, { [cls]: modelJson(trainShapeModel(cls, [g])) })
    if (s) donors.push([id, s])
  }
  donors.sort((a, b) => a[1].dev - b[1].dev)
  const med = donors[Math.floor(donors.length / 2)]
  console.log(`\n${c.id} #${c.fdi}  technician relief ${lib?.reliefTech.toFixed(2)} mm   (deviation mean / p90 mm)`)
  console.log(`  library       ${fmt(lib)}`)
  console.log(`  mean of ${String(others.length).padEnd(2)}   ${fmt(mean)}`)
  if (med) console.log(`  donor median  ${fmt(med[1])}  (${med[0]})`)
  if (donors[0]) console.log(`  donor best    ${fmt(donors[0][1])}  (${donors[0][0]})`)
  log(c, 'library', lib)
  log(c, 'mean', mean)
  for (const [id, s] of donors) log(c, `donor:${id}`, s)
}
writeFileSync(join(root, 'anatomy-loo.csv'), rows.join('\n') + '\n')
console.log(`\n→ ${join(root, 'anatomy-loo.csv')}`)
