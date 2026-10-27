/**
 * .sih case files from the command line.
 *
 *   npm run sih -- pack <case folder> [--out case.sih] [--tooth 30] [--fdi] [--material zirconia-hs] [--shade A2]
 *   npm run sih -- unpack <case.sih> [--out folder]
 *   npm run sih -- info <case.sih>
 *
 * pack reads a case folder of scans and recognises:
 *   - jaws: prep_jaw / opposing_jaw, or upper_jaw / lower_jaw (the tooth decides which is the prep);
 *   - a separate die (die*.obj|ply|stl), set into the prep jaw;
 *   - raw scanner exports: prep_raw / opposing_raw / upper_raw / lower_raw / bite_raw;
 *   - the finished crown: crown*.stl or design*.stl;
 *   - an exocad-style case.json: fdi_tooth, material, margin_points.
 * Anything else in the folder (e.g. .constructionInfo) is kept under extra/.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import * as THREE from 'three'
import { sihFromLabFiles } from '../src/core/labCase'
import { plyBinary, readSih, writeSih } from '../src/core/sih'

const args = process.argv.slice(2).filter((a) => a !== '--')
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const [cmd, input] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--fdi'))
const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const MESH = /\.(obj|ply|stl)$/i

async function pack(dir: string): Promise<void> {
  const names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile())
  const files = names.map((n) => ({ name: n, data: ab(readFileSync(join(dir, n))) }))
  const tooth = flag('tooth') ? Number(flag('tooth')) : undefined
  const c = sihFromLabFiles(files, { id: basename(dir), ...(tooth !== undefined ? { tooth, system: args.includes('--fdi') ? ('fdi' as const) : ('universal' as const) } : {}), material: flag('material'), shade: flag('shade') })
  if (!c) throw new Error(`${dir}: not a lab case (needs prep_jaw.* / upper_jaw.* / lower_jaw.*, and a tooth from --tooth or case.json).`)
  const bytes = await writeSih(c)
  const out = flag('out') ?? `${dir.replace(/[\\/]$/, '')}.sih`
  writeFileSync(out, bytes)
  const size = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`
  const before = names.reduce((s, n) => s + statSync(join(dir, n)).size, 0)
  console.log(`${out}: #${c.case.tooth} · ${c.scans.map((x) => x.role).join(', ')}${c.design?.crown ? ' · crown' : ''}${c.design?.margin ? ' · margin' : ''} · ${size(bytes.length)} (folder ${size(before)})`)
}

async function open(file: string): Promise<Awaited<ReturnType<typeof readSih>>> {
  return readSih(ab(readFileSync(file)))
}

if (cmd === 'pack' && input) {
  const dirs = existsSync(join(input, 'case.json')) || readdirSync(input).some((n) => MESH.test(n)) ? [input] : readdirSync(input).map((n) => join(input, n)).filter((d) => /case\d+$/i.test(d))
  for (const d of dirs) {
    try {
      await pack(d)
    } catch (e) {
      console.log(`skip ${d}: ${e instanceof Error ? e.message : e}`)
    }
  }
} else if (cmd === 'info' && input) {
  const c = await open(input)
  const m = c.manifest
  console.log(`${input}: ${m.format} · created ${m.created} by ${m.generator}`)
  console.log(`  case: ${JSON.stringify(m.case)}`)
  for (const s of m.scans) console.log(`  scan ${s.role}${s.jaw ? ` (${s.jaw})` : ''}: ${s.vertices} vertices, ${s.triangles} triangles${s.colour ? ', colour' : ''}${s.source ? ` · from ${s.source}` : ''}`)
  if (m.design) console.log(`  design: ${[m.design.margin ? `margin ${m.design.margin.length} pts` : '', m.design.insertionAxis ? 'axis' : '', m.design.crown ? 'crown' : '', m.design.record ? 'record' : ''].filter(Boolean).join(', ')}`)
  if (m.extra?.length) console.log(`  extra: ${m.extra.join(', ')}`)
  console.log(`  ${m.files.length} files, all checksums verified`)
} else if (cmd === 'unpack' && input) {
  const c = await open(input)
  const out = flag('out') ?? input.replace(/\.sih$/i, '')
  mkdirSync(out, { recursive: true })
  for (const s of c.scans) writeFileSync(join(out, `${s.role}${s.jaw ? `-${s.jaw}jaw` : ''}.ply`), plyBinary(s.geometry))
  if (c.design?.crown) {
    const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js')
    writeFileSync(join(out, 'crown.stl'), Buffer.from(new STLExporter().parse(new THREE.Mesh(c.design.crown), { binary: true }).buffer as ArrayBuffer))
  }
  writeFileSync(join(out, 'case.json'), JSON.stringify({ case: c.case, design: c.design ? { ...c.design, crown: undefined, record: undefined } : undefined }, null, 1))
  if (c.design?.record) writeFileSync(join(out, 'design-record.json'), JSON.stringify(c.design.record, null, 1))
  for (const e of c.extra ?? []) writeFileSync(join(out, e.name), e.data)
  console.log(`${input} → ${out}/ (${c.scans.length} scans${c.design?.crown ? ', crown' : ''})`)
} else {
  console.log('usage:\n  npm run sih -- pack <case folder | folder of caseNN> [--out x.sih] [--tooth N] [--fdi] [--material id] [--shade A2]\n  npm run sih -- unpack <case.sih> [--out folder]\n  npm run sih -- info <case.sih>')
  process.exit(1)
}
