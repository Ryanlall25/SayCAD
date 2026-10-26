/**
 * Scores the crown engine against finished lab cases (local only — cases live
 * in the git-ignored dev/cases/<set>/caseNN/):
 *
 *   npm run eval -- dev/cases/exo [--library round|rectangular]
 *
 * Each case folder holds prep_jaw / opposing_jaw scans (OBJ, PLY or STL, in
 * the bite), crown_exocad.stl (the technician's finished crown) and case.json
 * ({ fdi_tooth, margin_points }: the technician's margin). Per case it runs
 * the engine twice — fully automatic, and on the technician's margin (which
 * isolates the crown design from margin finding) — and reports margin error
 * against the technician, crown surface deviation from the technician's
 * crown, and the QC verdict. Our crowns land in <case>/out/ for rendering.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { SurfaceIndex, type Vec3 } from '../src/crown/geom'
import { marginError } from '../src/crown/margin'
import { designCase, type CrownOutcome } from '../src/module'
import { parseScan } from '../src/core/meshConvert'

const args = process.argv.slice(2).filter((a) => a !== '--')
const root = args.find((a) => !a.startsWith('--')) ?? 'dev/cases/exo'
const li = args.indexOf('--library')
const library = li >= 0 ? args[li + 1] : 'round'

const anatomy: Record<string, string> = {}
for (const f of existsSync('public/models') ? readdirSync('public/models') : []) {
  const m = /^ssm-(\w+)\.json$/.exec(f)
  if (m) anatomy[m[1]] = readFileSync(join('public/models', f), 'utf8')
  const t = /^lib-([a-z0-9-]+)-t(\d+)\.json$/.exec(f)
  if (t && t[1] === library) anatomy[`t${t[2]}`] = readFileSync(join('public/models', f), 'utf8')
}

const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const scanIn = (dir: string, stem: string): { name: string; data: ArrayBuffer } => {
  const f = readdirSync(dir).find((x) => x.startsWith(stem + '.'))
  if (!f) throw new Error(`${dir}: no ${stem}.*`)
  return { name: f, data: ab(readFileSync(join(dir, f))) }
}

/**
 * exocad Model Creator models carry the prepared tooth as a separate die and
 * a socket in the jaw: the prep surface is the die, set into the jaw with the
 * jaw's own copy of that area (within 1.2 mm of the die) removed.
 */
function prepWithDie(dir: string): { name: string; mesh: { positions: Float32Array; indices: Uint32Array } } | null {
  const die = readdirSync(dir).find((x) => x.startsWith('prep_die.'))
  if (!die) return null
  const jawIn = scanIn(dir, 'prep_jaw')
  const jaw = parseScan(jawIn.name, jawIn.data)
  const dg = parseScan(die, ab(readFileSync(join(dir, die))))
  const dieIdx = new SurfaceIndex(dg)
  const pos: number[] = []
  const idx: number[] = []
  const add = (g: typeof jaw, keep: (a: number, b: number, c: number) => boolean): void => {
    const p = g.getAttribute('position')
    const ix = g.index!
    const base = pos.length / 3
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i))
    for (let t = 0; t < ix.count; t += 3) {
      const a = ix.getX(t), b = ix.getX(t + 1), c = ix.getX(t + 2)
      if (keep(a, b, c)) idx.push(base + a, base + b, base + c)
    }
  }
  const jp = jaw.getAttribute('position')
  add(jaw, (a, b, c) => {
    const cx = (jp.getX(a) + jp.getX(b) + jp.getX(c)) / 3
    const cy = (jp.getY(a) + jp.getY(b) + jp.getY(c)) / 3
    const cz = (jp.getZ(a) + jp.getZ(b) + jp.getZ(c)) / 3
    return !dieIdx.closest([cx, cy, cz], 1.2)
  })
  add(dg, () => true)
  return { name: 'prep_jaw+die.obj', mesh: { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) } }
}

/** Mean / 90th-percentile / max distance from our crown's vertices to the technician's crown surface. */
function deviation(ours: CrownOutcome, truth: SurfaceIndex): { mean: number; p90: number; max: number } | null {
  const stl = ours.files?.crownStl
  if (!stl) return null
  const g = new STLLoader().parse(stl)
  const pos = g.getAttribute('position')
  const d: number[] = []
  for (let i = 0; i < pos.count; i += 3) d.push(truth.closest([pos.getX(i), pos.getY(i), pos.getZ(i)], 10)?.distance ?? 10)
  d.sort((a, b) => a - b)
  return { mean: d.reduce((s, x) => s + x, 0) / d.length, p90: d[Math.floor(d.length * 0.9)], max: d[d.length - 1] }
}

const fmt = (x: number | null | undefined, k = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(k))
const rows: string[] = ['case,tooth_fdi,mode,status,verdict,margin_mean_mm,margin_p95_mm,crown_dev_mean_mm,crown_dev_p90_mm,fails,warns,seconds']

for (const c of readdirSync(root).filter((d) => /^case\d+$/.test(d)).sort()) {
  const dir = join(root, c)
  const info = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as { fdi_tooth: number; margin_points: Vec3[] }
  const truthCrown = new SurfaceIndex(new STLLoader().parse(ab(readFileSync(join(dir, 'crown_exocad.stl')))))
  const prep = prepWithDie(dir) ?? scanIn(dir, 'prep_jaw')
  const antagonist = scanIn(dir, 'opposing_jaw')
  for (const mode of ['auto', 'tech-margin'] as const) {
    const t0 = Date.now()
    const out = designCase({
      contract: 'saycad.crown/1',
      jobId: `${c}-${mode}`,
      order: { tooth: info.fdi_tooth, system: 'fdi', material: 'zirconia-hs' },
      scans: { prep, antagonist },
      options: { anatomy, ...(mode === 'tech-margin' ? { margin: info.margin_points } : {}) }
    } as Parameters<typeof designCase>[0])
    const secs = (Date.now() - t0) / 1000
    const record = out.files?.designRecord ?? null
    const me = record?.margin?.length ? marginError(record.margin, info.margin_points) : null
    const dev = deviation(out, truthCrown)
    const fails = out.checks?.filter((x) => x.verdict === 'fail') ?? []
    const warns = out.checks?.filter((x) => x.verdict === 'warn') ?? []
    console.log(
      `${c} #${info.fdi_tooth} ${mode.padEnd(11)} ${out.status}${out.verdict ? '/' + out.verdict : ''} · margin ${fmt(me?.mean)} mean / ${fmt(me?.p95)} p95 mm · crown vs technician ${fmt(dev?.mean)} mean / ${fmt(dev?.p90)} p90 mm · ${secs.toFixed(1)} s`
    )
    for (const f of [...fails, ...warns]) console.log(`    ${f.verdict.toUpperCase()} ${f.label}: ${f.measured}`)
    if (out.needs?.length) console.log('    needs:', out.needs.map((n) => n.message).join(' | '))
    rows.push([c, info.fdi_tooth, mode, out.status, out.verdict ?? '', fmt(me?.mean, 3), fmt(me?.p95, 3), fmt(dev?.mean, 3), fmt(dev?.p90, 3), fails.map((f) => f.id).join(' '), warns.map((f) => f.id).join(' '), secs.toFixed(1)].join(','))
    if (out.files?.crownStl) {
      mkdirSync(join(dir, 'out'), { recursive: true })
      writeFileSync(join(dir, 'out', `crown-${mode}.stl`), Buffer.from(out.files.crownStl))
      if (record?.margin) writeFileSync(join(dir, 'out', `margin-${mode}.json`), JSON.stringify(record.margin))
    }
  }
}
writeFileSync(join(root, 'eval.csv'), rows.join('\n') + '\n')
console.log(`\n→ ${join(root, 'eval.csv')}`)
