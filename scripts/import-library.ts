/**
 * Import a tooth library (one STL per tooth, in arch position) as the anatomy
 * the designer starts from.
 *
 *   npm run import-library -- <folder> [--numbering auto|universal|fdi] [--name "MOD library"] [--out public/models]
 *
 * File names must contain the tooth number ("16.stl", "tooth_36.stl").
 * The output models are git-ignored: a library keeps its publisher's licence.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { analyseLibrary, libraryModels, libraryToothNumber, type LibraryTooth } from '../src/crown/library'

const args = process.argv.slice(2).filter((a) => a !== '--')
const dir = args.find((a) => !a.startsWith('--'))
const opt = (k: string, d: string): string => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
if (!dir || !existsSync(dir)) {
  console.error('usage: npm run import-library -- <folder> [--numbering auto|universal|fdi] [--name "…"] [--out public/models]')
  process.exit(1)
}
const files = readdirSync(dir).filter((f) => /\.(stl|ply)$/i.test(f))
const numbering = opt('numbering', 'auto') as 'auto' | 'universal' | 'fdi'
const teeth: LibraryTooth[] = []
for (const f of files) {
  const n = libraryToothNumber(f, numbering, files)
  if (!n) {
    console.warn(`skip ${f}: no tooth number in the name`)
    continue
  }
  const b = readFileSync(join(dir, f))
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  teeth.push({ name: f, toothNumber: n, geometry: /\.ply$/i.test(f) ? new PLYLoader().parse(ab) : new STLLoader().parse(ab) })
}
const imported = analyseLibrary(teeth)
for (const t of imported) console.log(`${t.name} → #${t.toothNumber} ${t.cls}: ${t.shape ? 'ok' : `SKIPPED (${t.error})`}`)
const models = libraryModels(imported, opt('name', 'tooth library'))
const out = opt('out', 'public/models')
mkdirSync(out, { recursive: true })
for (const [cls, m] of Object.entries(models)) {
  if (!m) continue
  writeFileSync(join(out, `ssm-${cls}.json`), JSON.stringify(m))
  console.log(`wrote ${out}/ssm-${cls}.json (${m.count} teeth)`)
}
