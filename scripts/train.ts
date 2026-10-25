/**
 * Train the crown engine on the lab's finished cases and score it.
 *
 *   npx vite-node scripts/train.ts -- <casesDir> [--out public/models] [--report reports/training-report.md] [--no-eval]
 *
 * <casesDir> holds one folder per case. Each folder contains the exported
 * STL/PLY files (prep arch, opposing arch, the shipped crown) and ideally a
 * case.json: { "toothNumber": 19, "prep": "…", "antagonist": "…", "crown": "…" }.
 * Without case.json, roles and the tooth number are guessed from file names.
 *
 * Writes one shape model per tooth class (ssm-<class>.json — the app loads
 * these automatically) and a Markdown report with margin accuracy and
 * leave-one-out design accuracy against the technicians' crowns.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { assignRoles, toothFromNames, type CaseManifest } from '../src/crown/caseFiles'
import { analyseCase, evaluate, trainModels, trainingReport, type TrainingCase } from '../src/crown/train'

const args = process.argv.slice(2).filter((a) => a !== '--')
const dir = args.find((a) => !a.startsWith('--'))
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
if (!dir || !existsSync(dir)) {
  console.error('usage: npx vite-node scripts/train.ts -- <casesDir> [--out public/models] [--report reports/training-report.md] [--no-eval]')
  process.exit(1)
}
const outDir = opt('out', 'public/models')
const reportPath = opt('report', 'reports/training-report.md')

function load(path: string): THREE.BufferGeometry {
  const buf = readFileSync(path)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const g = path.toLowerCase().endsWith('.ply') ? new PLYLoader().parse(ab) : new STLLoader().parse(ab)
  return g
}

const cases: TrainingCase[] = []
for (const name of readdirSync(dir).sort()) {
  const caseDir = join(dir, name)
  if (!statSync(caseDir).isDirectory()) continue
  const files = readdirSync(caseDir)
  const manifest: Partial<CaseManifest> = existsSync(join(caseDir, 'case.json')) ? JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8')) : {}
  const tooth = manifest.toothNumber ?? toothFromNames([name, ...files])
  if (!tooth) {
    console.warn(`skip ${name}: no tooth number (add case.json)`)
    continue
  }
  const roles = assignRoles(files, { ...manifest, toothNumber: tooth })
  const pick = (r: string): string | undefined => Object.keys(roles).find((f) => roles[f] === r)
  const prep = pick('prep')
  const crown = pick('crown')
  const ant = pick('antagonist')
  if (!prep || !crown) {
    console.warn(`skip ${name}: need a prep scan and a crown (found roles: ${JSON.stringify(roles)})`)
    continue
  }
  cases.push({ id: name, toothNumber: tooth, prep: load(join(caseDir, prep)), crown: load(join(caseDir, crown)), antagonist: ant ? load(join(caseDir, ant)) : null })
}
console.log(`loaded ${cases.length} case(s) from ${dir}`)

const analyses = cases.map((c, k) => {
  const a = analyseCase(c)
  console.log(`[${k + 1}/${cases.length}] ${c.id} #${c.toothNumber}: ${a.ok ? `margin err ${a.marginError!.mean.toFixed(3)} mm` : `SKIPPED — ${a.error}`}`)
  return a
})
const models = trainModels(analyses, 'SmileHub cases')
mkdirSync(outDir, { recursive: true })
for (const [cls, m] of Object.entries(models)) {
  if (!m) continue
  writeFileSync(join(outDir, `ssm-${cls}.json`), JSON.stringify(m))
  console.log(`model ${cls}: ${m.count} crowns, ${m.modes.length} modes`)
}
const rows = args.includes('--no-eval') ? [] : evaluate(cases, analyses, (d, t) => process.stdout.write(`\revaluating ${d}/${t}`))
console.log('')
mkdirSync(join(reportPath, '..'), { recursive: true })
writeFileSync(reportPath, trainingReport(analyses, models, rows))
console.log(`report → ${reportPath}`)
