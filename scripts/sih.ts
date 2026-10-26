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
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { parseScan } from '../src/core/meshConvert'
import { plyBinary, readSih, writeSih, type SihCase, type SihScan } from '../src/core/sih'
import { SurfaceIndex } from '../src/crown/geom'
import { fdiToUniversal } from '../src/crown/library'

const args = process.argv.slice(2).filter((a) => a !== '--')
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const [cmd, input] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--fdi'))
const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const MESH = /\.(obj|ply|stl)$/i

/** A die set into its jaw: the jaw's own copy of that area (within 1.2 mm of the die) removed. */
function setDie(jaw: THREE.BufferGeometry, die: THREE.BufferGeometry): THREE.BufferGeometry {
  const near = new SurfaceIndex(die)
  const pos: number[] = []
  const col: number[] = []
  const idx: number[] = []
  const coloured = !!jaw.getAttribute('color') && !!die.getAttribute('color')
  const add = (g: THREE.BufferGeometry, keep: (a: number, b: number, c: number) => boolean): void => {
    const p = g.getAttribute('position')
    const c = g.getAttribute('color')
    const ix = g.index
    const base = pos.length / 3
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i))
      if (coloured) col.push(c.getX(i), c.getY(i), c.getZ(i))
    }
    const n = ix ? ix.count : p.count
    for (let t = 0; t < n; t += 3) {
      const a = ix ? ix.getX(t) : t, b = ix ? ix.getX(t + 1) : t + 1, cc = ix ? ix.getX(t + 2) : t + 2
      if (keep(a, b, cc)) idx.push(base + a, base + b, base + cc)
    }
  }
  const jp = jaw.getAttribute('position')
  add(jaw, (a, b, c) => !near.closest([(jp.getX(a) + jp.getX(b) + jp.getX(c)) / 3, (jp.getY(a) + jp.getY(b) + jp.getY(c)) / 3, (jp.getZ(a) + jp.getZ(b) + jp.getZ(c)) / 3], 1.2))
  add(die, () => true)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3))
  if (coloured) g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(col), 3))
  g.setIndex(idx)
  return g
}

async function pack(dir: string): Promise<void> {
  const names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile())
  const find = (re: RegExp): string | undefined => names.find((n) => re.test(n) && MESH.test(n))
  const load = (n: string): THREE.BufferGeometry => (/\.stl$/i.test(n) && /crown|design/i.test(n) ? new STLLoader().parse(ab(readFileSync(join(dir, n)))) : parseScan(n, ab(readFileSync(join(dir, n)))))
  const info = existsSync(join(dir, 'case.json')) ? (JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as { fdi_tooth?: number; material?: string; margin_points?: [number, number, number][]; restorations?: Array<{ fdi: number; type: string }> }) : {}
  const fdi = flag('tooth') ? (args.includes('--fdi') ? Number(flag('tooth')) : null) : (info.fdi_tooth ?? info.restorations?.find((r) => /Crown|Inlay|Onlay|Veneer/i.test(r.type))?.fdi ?? null)
  const tooth = fdi !== null ? fdiToUniversal(fdi) : flag('tooth') ? Number(flag('tooth')) : null
  if (!tooth) throw new Error(`${dir}: which tooth? Give --tooth, or a case.json with fdi_tooth.`)
  const upperTooth = tooth <= 16
  const prepName = find(/^prep_jaw\./i) ?? find(upperTooth ? /^upper_jaw\./i : /^lower_jaw\./i)
  const antName = find(/^opposing_jaw\./i) ?? find(upperTooth ? /^lower_jaw\./i : /^upper_jaw\./i)
  if (!prepName) throw new Error(`${dir}: no prep jaw scan (prep_jaw.* or ${upperTooth ? 'upper' : 'lower'}_jaw.*).`)
  const prepJaw: 'upper' | 'lower' = upperTooth ? 'upper' : 'lower'
  const antJaw: 'upper' | 'lower' = upperTooth ? 'lower' : 'upper'
  const dieName = find(new RegExp(`^(prep_)?die(_${fdi ?? ''})?\\.`, 'i')) ?? find(/^(prep_)?die/i)
  let prep = load(prepName)
  if (dieName) prep = setDie(prep, load(dieName))
  const scans: SihScan[] = [{ role: 'prep', jaw: prepJaw, source: dieName ? `${prepName} + ${dieName}` : prepName, geometry: prep }]
  if (antName) scans.push({ role: 'antagonist', jaw: antJaw, source: antName, geometry: load(antName) })
  if (dieName) scans.push({ role: 'die', jaw: prepJaw, source: dieName, geometry: load(dieName) })
  const raw: Array<[RegExp, SihScan['role'], 'upper' | 'lower' | undefined]> = [
    [/^prep_raw\./i, 'raw-prep', prepJaw],
    [/^opposing_raw\./i, 'raw-antagonist', antJaw],
    [upperTooth ? /^upper_raw\./i : /^lower_raw\./i, 'raw-prep', prepJaw],
    [upperTooth ? /^lower_raw\./i : /^upper_raw\./i, 'raw-antagonist', antJaw],
    [/^bite_raw\./i, 'raw-bite', undefined]
  ]
  for (const [re, role, jaw] of raw) {
    const n = find(re)
    if (n && !scans.some((s) => s.source === n)) scans.push({ role, ...(jaw ? { jaw } : {}), source: n, geometry: load(n) })
  }
  const crownName = names.find((n) => /^(crown|design)[^/]*\.stl$/i.test(n))
  const used = new Set([prepName, antName, dieName, crownName, 'case.json', ...scans.map((s) => s.source)].filter(Boolean) as string[])
  const extra = names.filter((n) => !used.has(n) && !MESH.test(n) && !n.startsWith('.')).map((n) => ({ name: n, data: new Uint8Array(readFileSync(join(dir, n))) }))
  const c: SihCase = {
    case: { id: basename(dir), tooth, system: 'universal', ...(flag('material') ?? info.material ? { material: flag('material') ?? info.material } : {}), ...(flag('shade') ? { shade: flag('shade') } : {}) },
    scans,
    ...(info.margin_points || crownName ? { design: { ...(info.margin_points ? { margin: info.margin_points } : {}), ...(crownName ? { crown: load(crownName) } : {}) } } : {}),
    ...(extra.length ? { extra } : {})
  }
  const bytes = await writeSih(c)
  const out = flag('out') ?? `${dir.replace(/[\\/]$/, '')}.sih`
  writeFileSync(out, bytes)
  const size = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`
  const before = names.reduce((s, n) => s + statSync(join(dir, n)).size, 0)
  console.log(`${out}: #${tooth} · ${scans.map((s) => s.role).join(', ')}${crownName ? ' · crown' : ''}${info.margin_points ? ' · margin' : ''} · ${size(bytes.length)} (folder ${size(before)})`)
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
