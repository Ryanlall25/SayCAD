/**
 * Writes a folder of synthetic training cases in the layout scripts/train.ts
 * expects — a dry run of the training pipeline before real cases exist.
 *
 *   npx vite-node scripts/synthetic-cases.ts -- <outDir> [count]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { autoDesign, prepareCase } from '../src/crown/pipeline'
import { syntheticMolarCase } from '../src/crown/synthetic'

const args = process.argv.slice(2).filter((a) => a !== '--')
const out = args[0] ?? 'synthetic-cases'
const count = Number(args[1] ?? 6)
const stl = (g: THREE.BufferGeometry): DataView => new STLExporter().parse(new THREE.Mesh(g), { binary: true }) as DataView
const c = syntheticMolarCase()
const pc = prepareCase({ toothNumber: 19, prep: c.prep, antagonist: c.antagonist })
for (let k = 0; k < count; k++) {
  const dir = join(out, `case-${String(k + 1).padStart(3, '0')}`)
  mkdirSync(dir, { recursive: true })
  const crown = autoDesign(pc, {
    tap: c.tapPoint,
    params: { cuspScale: 0.8 + 0.4 * ((k * 37) % 11) / 10, buccalBulgeMm: 0.25 * ((k * 17) % 5) / 4, occlusalContacts: false }
  }).crown
  writeFileSync(join(dir, 'patient-lowerjaw.stl'), new Uint8Array(stl(c.prep).buffer))
  writeFileSync(join(dir, 'patient-upperjaw.stl'), new Uint8Array(stl(c.antagonist).buffer))
  writeFileSync(join(dir, '19-crown.stl'), new Uint8Array(stl(crown).buffer))
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ toothNumber: 19 }, null, 2))
}
console.log(`wrote ${count} synthetic cases to ${out}`)
