/**
 * Crown module CLI — the same designCase() the suite and the phone use.
 *
 *   npm run crown -- design <case.zip | case-folder | files…> --tooth 19 [--fdi] [--material zirconia-hs] [--align-z] [--out dir]
 *   npm run crown -- batch <folder of cases> [--out dir]
 *
 * A case is a zip or a folder of scans (+ optional job.json / .dentalProject).
 * Writes <out>/<case>/{crown STL, outcome.json, design-record.json}; batch
 * also writes <out>/batch.csv. Anatomy models in public/models/ are used.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { designCase, jobFromBundle, outcomeFiles, type BundleFile, type CrownOrder, type CrownOutcome } from '../src/module'
import type { MaterialId } from '../src/crown/materials'

const args = process.argv.slice(2).filter((a) => a !== '--')
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string): boolean => args.includes(`--${name}`)
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--fdi', '--align-z'].includes(args[i - 1])))
const [cmd, ...inputs] = positional
const out = flag('out') ?? 'crown-out'

// Anatomy: class models (ssm-<class>.json) and the chosen library's per-tooth
// models (lib-<family>-t<n>.json → key t<n>); --library round|rectangular.
const library = flag('library') ?? 'round'
const anatomy: Record<string, string> = {}
if (existsSync('public/models')) {
  for (const f of readdirSync('public/models')) {
    const m = /^ssm-(\w+)\.json$/.exec(f)
    if (m) anatomy[m[1]] = readFileSync(join('public/models', f), 'utf8')
    const t = /^lib-([a-z0-9-]+)-t(\d+)\.json$/.exec(f)
    if (t && t[1] === library) anatomy[`t${t[2]}`] = readFileSync(join('public/models', f), 'utf8')
  }
}

const readAll = (p: string): BundleFile[] => {
  const st = statSync(p)
  if (st.isDirectory()) return readdirSync(p).filter((f) => statSync(join(p, f)).isFile()).map((f) => ({ name: f, data: ab(readFileSync(join(p, f))) }))
  return [{ name: basename(p), data: ab(readFileSync(p)) }]
}
const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

async function runCase(name: string, files: BundleFile[], order: Partial<CrownOrder>): Promise<{ name: string; outcome: CrownOutcome | null; problems: string[]; ms: number }> {
  const t0 = Date.now()
  const { job, problems, notes } = await jobFromBundle(files, order, name)
  for (const n of notes) console.log(`  · ${n}`)
  if (!job) return { name, outcome: null, problems, ms: Date.now() - t0 }
  job.options = { ...job.options, anatomy: { ...anatomy, ...job.options?.anatomy }, alignInsertionToZ: has('align-z') || job.options?.alignInsertionToZ }
  const outcome = designCase(job)
  const dir = join(out, name)
  mkdirSync(dir, { recursive: true })
  for (const f of outcomeFiles(outcome)) writeFileSync(join(dir, f.name), f.data)
  return { name, outcome, problems: [], ms: Date.now() - t0 }
}

const line = (r: Awaited<ReturnType<typeof runCase>>): string => {
  const o = r.outcome
  if (!o) return `${r.name}: not started — ${r.problems.join(' ')}`
  if (o.status !== 'designed') return `${r.name}: ${o.status} — ${(o.needs ?? []).map((n) => n.message).join(' ') || o.error}`
  const s = o.summary!
  return `${r.name}: ${o.verdict} · #${o.tooth} · prep by ${o.prepFoundBy} · margin conf ${s.marginConfidence.toFixed(2)} · occlusal ${s.minOcclusalThicknessMm.toFixed(2)} mm · ${(r.ms / 1000).toFixed(1)} s`
}

const order: Partial<CrownOrder> = {}
if (flag('tooth')) order.tooth = Number(flag('tooth'))
if (has('fdi')) order.system = 'fdi'
if (flag('material')) order.material = flag('material') as MaterialId

if (cmd === 'design' && inputs.length) {
  const files = inputs.flatMap(readAll)
  const name = flag('name') ?? basename(inputs[0]).replace(/\.zip$/i, '')
  const r = await runCase(name, files, order)
  console.log(line(r))
  for (const w of r.outcome?.intake ?? []) console.log(`  ! ${w}`)
  for (const c of r.outcome?.checks?.filter((x) => x.verdict !== 'pass') ?? []) console.log(`  ${c.verdict.toUpperCase()} ${c.label}: ${c.measured} (need ${c.required})`)
  if (r.outcome?.files) console.log(`  → ${join(out, name)}`)
  process.exit(r.outcome?.status === 'designed' ? 0 : 2)
} else if (cmd === 'batch' && inputs[0]) {
  const root = inputs[0]
  const cases = readdirSync(root).filter((f) => statSync(join(root, f)).isDirectory() || /\.zip$/i.test(f))
  const rows = ['case,status,verdict,tooth,prep_found_by,margin_confidence,min_axial_mm,min_occlusal_mm,mesial_mm,distal_mm,seconds,needs']
  for (const c of cases) {
    const r = await runCase(c.replace(/\.zip$/i, ''), readAll(join(root, c)), order)
    console.log(line(r))
    const o = r.outcome
    const s = o?.summary
    const q = (x: unknown): string => `"${String(x ?? '').replace(/"/g, "'")}"`
    rows.push([c, o?.status ?? 'not-started', o?.verdict ?? '', o?.tooth ?? '', o?.prepFoundBy ?? '', s?.marginConfidence.toFixed(3) ?? '', s?.minAxialThicknessMm.toFixed(3) ?? '', s?.minOcclusalThicknessMm.toFixed(3) ?? '', s?.mesialContactMm?.toFixed(3) ?? '', s?.distalContactMm?.toFixed(3) ?? '', (r.ms / 1000).toFixed(1), q([...r.problems, ...(o?.needs ?? []).map((n) => n.message), o?.error ?? ''].filter(Boolean).join(' '))].join(','))
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'batch.csv'), rows.join('\n') + '\n')
  const done = rows.slice(1).filter((r) => r.split(',')[1] === 'designed').length
  console.log(`\n${done}/${cases.length} designed · ${join(out, 'batch.csv')}`)
} else {
  console.log('usage:\n  npm run crown -- design <case.zip|folder|files…> --tooth 19 [--fdi] [--material id] [--align-z] [--out dir]\n  npm run crown -- batch <folder of cases> [--tooth N] [--out dir]')
  process.exit(1)
}
