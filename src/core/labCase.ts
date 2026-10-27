import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { SurfaceIndex } from '../crown/geom'
import { fdiToUniversal } from '../crown/library'
import { parseScan } from './meshConvert'
import type { SihCase, SihScan } from './sih'

/**
 * A lab case folder (as exported from exocad, or as a .zip of one) → a .sih
 * case. Recognises:
 *   - jaws: prep_jaw / opposing_jaw, or upper_jaw / lower_jaw (the tooth decides which is the prep);
 *   - a separate die (die*.obj|ply|stl), set into the prep jaw;
 *   - raw scanner exports: prep_raw / opposing_raw / upper_raw / lower_raw / bite_raw;
 *   - the finished crown: crown*.stl or design*.stl;
 *   - case.json with fdi_tooth (or restorations[].fdi), material, margin_points.
 * Other non-mesh files are kept as extras. Returns null when the files don't
 * look like a lab case (no jaw scan named that way), so callers fall back to
 * their usual handling.
 */

export interface LabFile {
  name: string
  data: ArrayBuffer
}

interface LabCaseJson {
  fdi_tooth?: number
  material?: string
  margin_points?: [number, number, number][]
  restorations?: Array<{ fdi: number; type: string }>
}

const MESH = /\.(obj|ply|stl)$/i
const base = (n: string): string => n.split(/[\\/]/).pop()!

/** A die set into its jaw: the jaw's own copy of that area (within 1.2 mm of the die) removed. */
export function setDie(jaw: THREE.BufferGeometry, die: THREE.BufferGeometry): THREE.BufferGeometry {
  const near = new SurfaceIndex(die)
  const pos: number[] = []
  const col: number[] = []
  const idx: number[] = []
  const coloured = !!jaw.getAttribute('color') && !!die.getAttribute('color')
  const add = (g: THREE.BufferGeometry, keep: (a: number, b: number, c: number) => boolean): void => {
    const p = g.getAttribute('position')
    const c = g.getAttribute('color')
    const ix = g.index
    const start = pos.length / 3
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i))
      if (coloured) col.push(c.getX(i), c.getY(i), c.getZ(i))
    }
    const n = ix ? ix.count : p.count
    for (let t = 0; t < n; t += 3) {
      const a = ix ? ix.getX(t) : t
      const b = ix ? ix.getX(t + 1) : t + 1
      const cc = ix ? ix.getX(t + 2) : t + 2
      if (keep(a, b, cc)) idx.push(start + a, start + b, start + cc)
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

/** True when the names look like a lab case folder (so it's worth converting). */
export function looksLikeLabCase(names: string[]): boolean {
  const b = names.map(base)
  return b.some((n) => /^(prep|opposing|upper|lower)_jaw\.(obj|ply|stl)$/i.test(n))
}

export function sihFromLabFiles(files: LabFile[], opts: { id?: string; tooth?: number; system?: 'universal' | 'fdi'; material?: string; shade?: string } = {}): SihCase | null {
  const byName = new Map(files.map((f) => [base(f.name), f.data]))
  const names = [...byName.keys()]
  if (!looksLikeLabCase(names)) return null
  const find = (re: RegExp): string | undefined => names.find((n) => re.test(n) && MESH.test(n))
  const load = (n: string): THREE.BufferGeometry => (/\.stl$/i.test(n) && /crown|design/i.test(n) ? new STLLoader().parse(byName.get(n)!) : parseScan(n, byName.get(n)!))
  let info: LabCaseJson = {}
  const cj = byName.get('case.json')
  if (cj) {
    try {
      info = JSON.parse(new TextDecoder().decode(cj)) as LabCaseJson
    } catch {
      /* no usable order: the tooth must come from opts */
    }
  }
  const fdi = opts.tooth !== undefined ? (opts.system === 'fdi' ? opts.tooth : null) : (info.fdi_tooth ?? info.restorations?.find((r) => /Crown|Inlay|Onlay|Veneer/i.test(r.type))?.fdi ?? null)
  const tooth = fdi !== null ? fdiToUniversal(fdi) : (opts.tooth ?? null)
  if (!tooth) return null
  const upperTooth = tooth <= 16
  const prepJaw: 'upper' | 'lower' = upperTooth ? 'upper' : 'lower'
  const antJaw: 'upper' | 'lower' = upperTooth ? 'lower' : 'upper'
  const prepName = find(/^prep_jaw\./i) ?? find(upperTooth ? /^upper_jaw\./i : /^lower_jaw\./i)
  if (!prepName) return null
  const antName = find(/^opposing_jaw\./i) ?? find(upperTooth ? /^lower_jaw\./i : /^upper_jaw\./i)
  const dieName = (fdi !== null ? find(new RegExp(`^(prep_)?die_${fdi}\\.`, 'i')) : undefined) ?? find(/^(prep_)?die\./i) ?? find(/^(prep_)?die/i)
  const die = dieName ? load(dieName) : null
  const scans: SihScan[] = [{ role: 'prep', jaw: prepJaw, source: dieName ? `${prepName} + ${dieName}` : prepName, geometry: die ? setDie(load(prepName), die) : load(prepName) }]
  if (antName) scans.push({ role: 'antagonist', jaw: antJaw, source: antName, geometry: load(antName) })
  if (die) scans.push({ role: 'die', jaw: prepJaw, source: dieName, geometry: die })
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
  const extra = names.filter((n) => !used.has(n) && !MESH.test(n) && !n.startsWith('.')).map((n) => ({ name: n, data: new Uint8Array(byName.get(n)!) }))
  const material = opts.material ?? info.material
  return {
    case: { ...(opts.id ? { id: opts.id } : {}), tooth, system: 'universal', ...(material ? { material } : {}), ...(opts.shade ? { shade: opts.shade } : {}) },
    scans,
    ...(info.margin_points || crownName ? { design: { ...(info.margin_points ? { margin: info.margin_points } : {}), ...(crownName ? { crown: load(crownName) } : {}) } } : {}),
    ...(extra.length ? { extra } : {})
  }
}
