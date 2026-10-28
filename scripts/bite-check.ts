/**
 * How the technician's crown and ours sit against the antagonist (dev):
 *   npx vite-node scripts/bite-check.ts -- dev/cases/lm
 * Per crown: the closest approach to the opposing scan measured straight up
 * (SurfaceIndex.gapUp, the critic's measure) — negative = into the antagonist.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { parseScan } from '../src/core/meshConvert'
import { SurfaceIndex, toLocal, type ToothFrame, type Vec3 } from '../src/crown/geom'
import { fdiToUniversal } from '../src/crown/library'
import { analyseCase } from '../src/crown/train'
import { ab, listCases, loadLabCase } from './lib/labCases'

const root = process.argv.slice(2).filter((a) => a !== '--' && !a.startsWith('--'))[0] ?? 'dev/cases/lm'
for (const id of listCases(root)) {
  const c = loadLabCase(root, id)
  if (!c.antagonist) continue
  // Everything in the tooth frame (y = occlusal), as the engine measures the bite.
  const a = analyseCase({ id, toothNumber: fdiToUniversal(c.fdi)!, prep: c.prepGeometry, crown: c.crown })
  if (!a.frame) { console.log(id, 'no frame:', a.error); continue }
  const frame = a.frame as ToothFrame
  const local = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    const q = g.clone()
    const p = q.getAttribute('position')
    for (let i = 0; i < p.count; i++) { const v = toLocal(frame, [p.getX(i), p.getY(i), p.getZ(i)]); p.setXYZ(i, v[0], v[1], v[2]) }
    return q
  }
  const ant = new SurfaceIndex(local(parseScan(c.antagonist.name, c.antagonist.data)))
  const gaps = (g0: THREE.BufferGeometry): { min: number; p5: number } => {
    const g = local(g0)
    const p = g.getAttribute('position')
    const d: number[] = []
    for (let i = 0; i < p.count; i += 2) {
      const v: Vec3 = [p.getX(i), p.getY(i), p.getZ(i)]
      const s = ant.gapUp(v, 6)
      if (Number.isFinite(s) && s < 6) d.push(s)
    }
    d.sort((a, b) => a - b)
    return { min: d[0] ?? NaN, p5: d[Math.floor(d.length * 0.05)] ?? NaN }
  }
  const t = gaps(c.crown)
  // Heights (tooth frame): technician crown top and marginal ridges vs the neighbours' tops beside it.
  const tl = local(c.crown).getAttribute('position')
  let x0 = Infinity, x1 = -Infinity, top = -Infinity
  for (let i = 0; i < tl.count; i++) { x0 = Math.min(x0, tl.getX(i)); x1 = Math.max(x1, tl.getX(i)); top = Math.max(top, tl.getY(i)) }
  let ridgeM = -Infinity, ridgeD = -Infinity
  for (let i = 0; i < tl.count; i++) { const x = tl.getX(i), y = tl.getY(i); if (x > x1 - 1.2) ridgeM = Math.max(ridgeM, y); if (x < x0 + 1.2) ridgeD = Math.max(ridgeD, y) }
  const pl = local(c.prepGeometry).getAttribute('position')
  let nM = -Infinity, nD = -Infinity, nM2 = -Infinity, nD2 = -Infinity
  for (let i = 0; i < pl.count; i++) {
    const x = pl.getX(i), y = pl.getY(i), z = pl.getZ(i)
    if (Math.abs(z) > 4) continue
    if (x > x1 && x < x1 + 1.2) nM = Math.max(nM, y)
    if (x < x0 && x > x0 - 1.2) nD = Math.max(nD, y)
    if (x > x1 && x < x1 + 6) nM2 = Math.max(nM2, y)
    if (x < x0 && x > x0 - 6) nD2 = Math.max(nD2, y)
  }
  console.log(`${id} heights: tech top ${top.toFixed(2)} ridges M ${ridgeM.toFixed(2)} D ${ridgeD.toFixed(2)} | neighbour ridge M ${nM.toFixed(2)} D ${nD.toFixed(2)} | neighbour top M ${nM2.toFixed(2)} D ${nD2.toFixed(2)}`)
  const oursF = join(c.dir, 'out', 'crown-auto.stl')
  const o = existsSync(oursF) ? gaps(new STLLoader().parse(ab(readFileSync(oursF)))) : null
  console.log(`${id} technician min ${t.min.toFixed(2)} p5 ${t.p5.toFixed(2)}${o ? ` | ours min ${o.min.toFixed(2)} p5 ${o.p5.toFixed(2)}` : ''}`)
}
