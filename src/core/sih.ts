import * as THREE from 'three'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { unzip } from './unzip'
import { zip } from './zip'

/**
 * .sih — a SmileHub case, in one file ("Super Intelligence Hub").
 *
 * A zip of standard files, so every part still opens in any dental CAD,
 * mesh tool or printer software once unpacked:
 *
 *   sih.json            the manifest (always the first entry)
 *   scans/<role>.ply    binary PLY, vertex colour when the scanner gave it
 *   design/crown.stl    the finished restoration, when there is one
 *   design/record.json  the design record (params, checks), when there is one
 *   extra/<name>        anything else kept with the case (Rx, photos, …)
 *
 * What a bare mesh format can't carry lives in the manifest: tooth, jaw,
 * material and shade, the role of each scan, the margin line, insertion axis
 * and tooth frame — all in the one coordinate frame the scans share (jaws in
 * occlusion, millimetres). Every file is listed with its SHA-256, and a
 * reader refuses a case whose files don't match.
 */

export const SIH_FORMAT = 'sih/1'
export const SIH_EXTENSION = '.sih'

export type SihRole = 'prep' | 'antagonist' | 'bite' | 'preop' | 'die' | 'raw-prep' | 'raw-antagonist' | 'raw-bite' | 'other'
type V3 = [number, number, number]

export interface SihCaseInfo {
  id?: string
  /** Tooth number in `system`. */
  tooth?: number
  system?: 'universal' | 'fdi'
  restoration?: string
  material?: string
  shade?: string
  notes?: string
}

export interface SihScan {
  role: SihRole
  /** Which arch the scan is of, when known. */
  jaw?: 'upper' | 'lower'
  /** Where it came from (scanner, exporter); free text. */
  source?: string
  geometry: THREE.BufferGeometry
}

export interface SihDesign {
  /** Margin line, closed loop, case frame (mm). */
  margin?: V3[]
  /** Path of insertion (unit vector). */
  insertionAxis?: V3
  /** Tooth frame: origin + mesial / occlusal / buccal unit vectors. */
  frame?: { origin: V3; mesial: V3; occlusal: V3; buccal: V3 }
  crown?: THREE.BufferGeometry
  record?: unknown
}

export interface SihCase {
  case: SihCaseInfo
  scans: SihScan[]
  design?: SihDesign
  extra?: Array<{ name: string; data: Uint8Array }>
}

interface ManifestFile {
  path: string
  bytes: number
  sha256: string
}

export interface SihManifest {
  format: typeof SIH_FORMAT
  created: string
  generator: string
  units: 'mm'
  frame: string
  case: SihCaseInfo
  scans: Array<{ role: SihRole; jaw?: 'upper' | 'lower'; source?: string; file: string; vertices: number; triangles: number; colour: boolean }>
  design?: { margin?: V3[]; insertionAxis?: V3; frame?: SihDesign['frame']; crown?: string; record?: string }
  extra?: string[]
  files: ManifestFile[]
}

/* ── binary PLY ─────────────────────────────────────────────────────── */

/**
 * Binary little-endian PLY: float32 xyz, uchar rgb (when the geometry has
 * colour), int32 triangle indices. Readable by exocad, 3Shape, Meshmixer,
 * MeshLab, Blender and three.js.
 */
export function plyBinary(g: THREE.BufferGeometry): Uint8Array {
  const pos = g.getAttribute('position')
  const col = g.getAttribute('color')
  const n = pos.count
  const idx = g.index ? g.index.array : null
  const nf = (idx ? idx.length : n) / 3
  const header =
    'ply\nformat binary_little_endian 1.0\ncomment SmileHub .sih scan\n' +
    `element vertex ${n}\nproperty float x\nproperty float y\nproperty float z\n` +
    (col ? 'property uchar red\nproperty uchar green\nproperty uchar blue\n' : '') +
    `element face ${nf}\nproperty list uchar int vertex_indices\nend_header\n`
  const head = new TextEncoder().encode(header)
  const vb = col ? 15 : 12
  const out = new Uint8Array(head.length + n * vb + nf * 13)
  out.set(head)
  const dv = new DataView(out.buffer)
  let o = head.length
  const byte = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)))
  for (let i = 0; i < n; i++) {
    dv.setFloat32(o, pos.getX(i), true)
    dv.setFloat32(o + 4, pos.getY(i), true)
    dv.setFloat32(o + 8, pos.getZ(i), true)
    o += 12
    if (col) {
      out[o] = byte(col.getX(i))
      out[o + 1] = byte(col.getY(i))
      out[o + 2] = byte(col.getZ(i))
      o += 3
    }
  }
  for (let f = 0; f < nf; f++) {
    out[o] = 3
    for (let k = 0; k < 3; k++) dv.setInt32(o + 1 + 4 * k, idx ? Number(idx[f * 3 + k]) : f * 3 + k, true)
    o += 13
  }
  return out
}

function binaryStl(g: THREE.BufferGeometry): Uint8Array {
  const pos = g.getAttribute('position')
  const idx = g.index
  const nf = (idx ? idx.count : pos.count) / 3
  const out = new Uint8Array(84 + nf * 50)
  const dv = new DataView(out.buffer)
  dv.setUint32(80, nf, true)
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const v = idx ? idx.getX(f * 3 + k) : f * 3 + k
      const o = 84 + f * 50 + 12 + k * 12
      dv.setFloat32(o, pos.getX(v), true)
      dv.setFloat32(o + 4, pos.getY(v), true)
      dv.setFloat32(o + 8, pos.getZ(v), true)
    }
  }
  return out
}

async function sha256(data: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('')
}

/* ── write / read ───────────────────────────────────────────────────── */

export async function writeSih(c: SihCase, opts: { generator?: string; date?: Date } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const entries: Array<{ name: string; data: Uint8Array }> = []
  const used = new Map<string, number>()
  const unique = (stem: string): string => {
    const k = used.get(stem) ?? 0
    used.set(stem, k + 1)
    return k ? `${stem}-${k + 1}` : stem
  }
  const scans: SihManifest['scans'] = c.scans.map((s) => {
    const file = `scans/${unique(s.role)}.ply`
    entries.push({ name: file, data: plyBinary(s.geometry) })
    const tri = (s.geometry.index ? s.geometry.index.count : s.geometry.getAttribute('position').count) / 3
    return { role: s.role, ...(s.jaw ? { jaw: s.jaw } : {}), ...(s.source ? { source: s.source } : {}), file, vertices: s.geometry.getAttribute('position').count, triangles: tri, colour: !!s.geometry.getAttribute('color') }
  })
  let design: SihManifest['design']
  if (c.design) {
    const { crown, record, ...geo } = c.design
    design = { ...geo }
    if (crown) {
      entries.push({ name: 'design/crown.stl', data: binaryStl(crown) })
      design.crown = 'design/crown.stl'
    }
    if (record !== undefined) {
      entries.push({ name: 'design/record.json', data: new TextEncoder().encode(JSON.stringify(record, null, 1)) })
      design.record = 'design/record.json'
    }
  }
  const extra = (c.extra ?? []).map((e) => {
    const name = `extra/${e.name.split(/[\\/]/).pop()}`
    entries.push({ name, data: e.data })
    return name
  })
  const files: ManifestFile[] = []
  for (const e of entries) files.push({ path: e.name, bytes: e.data.length, sha256: await sha256(e.data) })
  const manifest: SihManifest = {
    format: SIH_FORMAT,
    created: (opts.date ?? new Date()).toISOString(),
    generator: opts.generator ?? 'SmileHub SayCAD',
    units: 'mm',
    frame: 'All scans, the margin and the crown share one coordinate frame, with the jaws in occlusion.',
    case: c.case,
    scans,
    ...(design ? { design } : {}),
    ...(extra.length ? { extra } : {}),
    files
  }
  return zip([{ name: 'sih.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) }, ...entries], opts.date)
}

export class SihError extends Error {}

/** Reads a .sih; verifies the format and every file's checksum. */
export async function readSih(buffer: ArrayBuffer): Promise<SihCase & { manifest: SihManifest }> {
  let entries: Awaited<ReturnType<typeof unzip>>
  try {
    entries = await unzip(buffer)
  } catch {
    throw new SihError('Not a .sih case: the file is not a readable package.')
  }
  const byName = new Map(entries.map((e) => [e.name, e.data]))
  const mj = byName.get('sih.json')
  if (!mj) throw new SihError('Not a .sih case: sih.json is missing.')
  let m: SihManifest
  try {
    m = JSON.parse(new TextDecoder().decode(mj)) as SihManifest
  } catch {
    throw new SihError('This .sih case has a damaged manifest.')
  }
  const major = /^sih\/(\d+)$/.exec(m.format ?? '')?.[1]
  if (major !== '1') throw new SihError(major ? `This case uses .sih version ${major}; this app reads version 1.` : 'Not a .sih case: unknown format.')
  for (const f of m.files ?? []) {
    const d = byName.get(f.path)
    if (!d) throw new SihError(`This .sih case is incomplete: ${f.path} is missing.`)
    if (d.length !== f.bytes || (await sha256(d)) !== f.sha256) throw new SihError(`This .sih case is damaged: ${f.path} doesn't match its checksum.`)
  }
  const buf = (d: Uint8Array): ArrayBuffer => d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer
  const scans: SihScan[] = m.scans.map((s) => ({
    role: s.role,
    ...(s.jaw ? { jaw: s.jaw } : {}),
    ...(s.source ? { source: s.source } : {}),
    geometry: new PLYLoader().parse(buf(byName.get(s.file)!))
  }))
  let design: SihDesign | undefined
  if (m.design) {
    const { crown, record, ...geo } = m.design
    design = { ...geo }
    if (crown && byName.get(crown)) design.crown = new STLLoader().parse(buf(byName.get(crown)!))
    if (record && byName.get(record)) design.record = JSON.parse(new TextDecoder().decode(byName.get(record)!))
  }
  const extra = (m.extra ?? []).filter((n) => byName.has(n)).map((n) => ({ name: n.slice('extra/'.length), data: byName.get(n)! }))
  return { manifest: m, case: m.case ?? {}, scans, ...(design ? { design } : {}), ...(extra.length ? { extra } : {}) }
}

/** A short file name for a scan that says its jaw and role (for name-based tools). */
export function sihScanFileName(s: Pick<SihScan, 'role' | 'jaw'>, ext = 'ply'): string {
  return `${s.role}${s.jaw ? `-${s.jaw}jaw` : ''}.${ext}`
}

export const isSih = (name: string): boolean => /\.sih$/i.test(name)
