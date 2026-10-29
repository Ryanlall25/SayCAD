/**
 * Builds donor sets — the lab's own finished crowns as starting anatomy — from
 * lab case folders (see scripts/lib/labCases.ts), one file per tooth class:
 *
 *   npm run train-donors -- dev/cases/lm [more roots…] [--out public/models]
 *
 * Writes public/models/donors-<class>.json (git-ignored: patient-derived).
 * `npm run eval -- <root> --donors` then designs each case from the others.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fdiToUniversal } from '../src/crown/library'
import { trainShapeModel } from '../src/crown/ssm'
import { analyseCase } from '../src/crown/train'
import type { DonorSet } from '../src/crown/donors'
import type { ToothClass } from '../src/crown/anatomy'
import { listCases, loadLabCase } from './lib/labCases'

const args = process.argv.slice(2).filter((a) => a !== '--')
const oi = args.indexOf('--out')
const out = oi >= 0 ? args[oi + 1] : 'public/models'
const roots = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out')
const sets = new Map<ToothClass, DonorSet>()
for (const root of roots) {
  for (const id of listCases(root)) {
    const c = loadLabCase(root, id)
    const tooth = fdiToUniversal(c.fdi)!
    const a = analyseCase({ id, toothNumber: tooth, prep: c.prepGeometry, crown: c.crown, margin: c.margin })
    if (!a.ok || !a.shape) {
      console.log(`skip ${id} #${c.fdi}: ${a.error}`)
      continue
    }
    const set = sets.get(a.cls) ?? sets.set(a.cls, { version: 1, cls: a.cls, donors: [] }).get(a.cls)!
    set.donors.push({ id, tooth, model: trainShapeModel(a.cls, [a.shape], { source: `lab crown ${id}` }), size: a.size })
    console.log(`${id} #${c.fdi} → ${a.cls}`)
  }
}
mkdirSync(out, { recursive: true })
for (const [cls, set] of sets) {
  const f = join(out, `donors-${cls}.json`)
  writeFileSync(f, JSON.stringify(set))
  console.log(`→ ${f} (${set.donors.length} crowns)`)
}
