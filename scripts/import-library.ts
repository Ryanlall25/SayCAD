/**
 * Import a tooth library (one mesh per tooth) as the anatomy the designer
 * starts from. Reads STL, PLY and exocad .eoff.
 *
 *   npm run import-library -- <folder> [--jaw upper|lower] [<folder> --jaw …] [--numbering auto|universal|fdi] [--name "…"] [--out public/models]
 *
 * File names carry the tooth number (Universal or FDI), or — with --jaw — the
 * position from the midline (exocad library folders: 1.eoff … 8.eoff).
 * Output models are git-ignored: a library keeps its publisher's licence.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { analyseLibrary, libraryModels, libraryToothNumber, type LibraryTooth } from '../src/crown/library'
import { parseEoff } from '../src/crown/eoff'

const args = process.argv.slice(2).filter((a) => a !== '--')
const opt = (k: string, d: string): string => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
// Folders, each optionally followed by --jaw.
const folders: Array<{ dir: string; jaw?: 'upper' | 'lower' }> = []
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    if (args[i] === '--jaw' && folders.length) folders[folders.length - 1].jaw = args[i + 1] as 'upper' | 'lower'
    i++
    continue
  }
  folders.push({ dir: args[i] })
}
if (!folders.length || folders.some((f) => !existsSync(f.dir))) {
  console.error('usage: npm run import-library -- <folder> [--jaw upper|lower] [--numbering auto|universal|fdi] [--name "…"] [--out public/models]')
  process.exit(1)
}
const numbering = opt('numbering', 'auto') as 'auto' | 'universal' | 'fdi'
const teeth: LibraryTooth[] = []
for (const { dir, jaw } of folders) {
  const files = readdirSync(dir).filter((f) => /\.(stl|ply|eoff)$/i.test(f))
  for (const f of files) {
    const n = libraryToothNumber(f, numbering, files, jaw)
    if (!n) {
      console.warn(`skip ${f}: no tooth number in the name (use --jaw for 1–8 names)`)
      continue
    }
    const b = readFileSync(join(dir, f))
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    const geometry = /\.eoff$/i.test(f) ? parseEoff(ab) : /\.ply$/i.test(f) ? new PLYLoader().parse(ab) : new STLLoader().parse(ab)
    teeth.push({ name: `${dir}/${f}`, toothNumber: n, geometry })
  }
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
