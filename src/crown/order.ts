/**
 * The case order — what exocad's DentalDB captures before design starts:
 * patient, tooth, restoration type, material, and which scans the case
 * has. From the order the app derives the scans it needs, in the order a
 * technician loads them (prep arch, opposing arch, then optional extras),
 * and checks each upload against what was asked for.
 */

import type { MaterialId } from './materials'
import { fdiToUniversal } from './library'

export type RestorationType = 'crown' | 'coping' | 'pontic' | 'inlay' | 'onlay' | 'veneer' | 'implantCrown'

export const RESTORATIONS: Array<{ id: RestorationType; label: string; ready: boolean }> = [
  { id: 'crown', label: 'Anatomic crown', ready: true },
  { id: 'coping', label: 'Coping / framework', ready: false },
  { id: 'implantCrown', label: 'Crown on implant', ready: false },
  { id: 'pontic', label: 'Bridge pontic', ready: false },
  { id: 'inlay', label: 'Inlay', ready: false },
  { id: 'onlay', label: 'Onlay', ready: false },
  { id: 'veneer', label: 'Veneer', ready: false }
]

export const SHADES = ['A1', 'A2', 'A3', 'A3.5', 'A4', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'C4', 'D2', 'D3', 'D4', 'BL1', 'BL2', 'BL3', 'BL4']

export interface CaseOrder {
  patient: string
  doctor: string
  due: string // yyyy-mm-dd or ''
  /** Universal numbering, 1–32. */
  tooth: number | null
  restoration: RestorationType
  material: MaterialId
  shade: string
  antagonist: boolean
  preop: boolean
  bite: boolean
}

export const NEW_ORDER: CaseOrder = {
  patient: '',
  doctor: '',
  due: '',
  tooth: null,
  restoration: 'crown',
  material: 'zirconia-hs',
  shade: 'A2',
  antagonist: true,
  preop: false,
  bite: false
}

export type SlotId = 'prep' | 'antagonist' | 'bite' | 'preop'
export type Jaw = 'upper' | 'lower'

export interface ScanSlot {
  id: SlotId
  required: boolean
  jaw: Jaw | null
  /** Short title, e.g. "Lower jaw scan". */
  title: string
  /** What to upload, phrased as the instruction shown to the user. */
  ask: string
  /** Where it comes from / what it's used for. */
  hint: string
  /** False when the file is kept with the case but not used by design yet. */
  used: boolean
}

export const jawOf = (universal: number): Jaw => (universal <= 16 ? 'upper' : 'lower')
const other = (j: Jaw): Jaw => (j === 'upper' ? 'lower' : 'upper')
const cap = (s: string): string => s[0].toUpperCase() + s.slice(1)

/** The scans this order needs, in loading order. Empty until a tooth is picked. */
export function scanSlots(order: CaseOrder, toothName = ''): ScanSlot[] {
  if (order.tooth === null) return []
  const jaw = jawOf(order.tooth)
  const t = `#${order.tooth}${toothName ? ` (${toothName})` : ''}`
  const slots: ScanSlot[] = [
    {
      id: 'prep',
      required: true,
      jaw,
      title: `${cap(jaw)} jaw scan`,
      ask: `Upload the ${jaw.toUpperCase()} jaw scan — the arch with the prep on ${t}.`,
      hint: 'Export it from the intraoral scanner as STL or PLY (or the whole export as .zip). Include the teeth on both sides of the prep.',
      used: true
    }
  ]
  if (order.antagonist)
    slots.push({
      id: 'antagonist',
      required: true,
      jaw: other(jaw),
      title: `${cap(other(jaw))} jaw scan`,
      ask: `Upload the ${other(jaw).toUpperCase()} jaw scan — the opposing arch.`,
      hint: 'Export it from the same scan session as the prep arch, so the two are already in the bite. It sets the occlusal contacts.',
      used: true
    })
  if (order.bite)
    slots.push({
      id: 'bite',
      required: false,
      jaw: null,
      title: 'Bite scan',
      ask: 'Upload the bite (buccal) scan.',
      hint: 'Kept with the case. SayCAD does not align arches from a bite scan yet — export the arches already in occlusion.',
      used: false
    })
  if (order.preop)
    slots.push({
      id: 'preop',
      required: false,
      jaw,
      title: 'Pre-op scan',
      ask: `Upload the pre-op scan — the ${jaw} jaw before ${t} was prepped.`,
      hint: 'Kept with the case for reference. It is not used to shape the crown yet.',
      used: false
    })
  return slots
}

/* ── file checks ─────────────────────────────────────────────────────── */

const jawInName = (name: string): Jaw | null => {
  const n = name.toLowerCase()
  const upper = /upper|maxill|oberkiefer|(^|[^a-z])(u|uj|ok|max)([^a-z]|$)|(^|[-_ ])u(pper)?jaw/.test(n)
  const lower = /lower|mandib|unterkiefer|(^|[^a-z])(l|lj|uk|mand)([^a-z]|$)|(^|[-_ ])l(ower)?jaw/.test(n)
  return upper === lower ? null : upper ? 'upper' : 'lower'
}
const isBite = (n: string): boolean => /bite|occlusion|buccal|biss/i.test(n)
const isPreop = (n: string): boolean => /pre[-_ ]?op|preop|situation|wax[-_ ]?up|initial/i.test(n)
const isCrown = (n: string): boolean => /crown|restoration|coping|[-_ ]cad[-_ .]/i.test(n)

export const SCAN_FILE = /\.(stl|ply)$/i

/** Which slot a file belongs in, judged by its name; null when unclear. */
export function slotForName(name: string, slots: ScanSlot[]): SlotId | null {
  if (!SCAN_FILE.test(name) || isCrown(name)) return null
  const ids = new Set(slots.map((s) => s.id))
  if (isBite(name)) return ids.has('bite') ? 'bite' : null
  if (isPreop(name)) return ids.has('preop') ? 'preop' : null
  const j = jawInName(name)
  if (!j) return null
  const s = slots.find((x) => (x.id === 'prep' || x.id === 'antagonist') && x.jaw === j)
  return s?.id ?? null
}

/** Files dropped at once → slots. Unclear files fill the first empty required slot. */
export function assignToSlots(names: string[], slots: ScanSlot[], filled: Partial<Record<SlotId, unknown>> = {}): Partial<Record<SlotId, string>> {
  const out: Partial<Record<SlotId, string>> = {}
  const taken = (id: SlotId): boolean => id in out || filled[id] !== undefined
  const unclear: string[] = []
  for (const n of names.filter((x) => SCAN_FILE.test(x))) {
    const id = slotForName(n, slots)
    if (id && !(id in out)) out[id] = n
    else if (!id && !isCrown(n) && !isBite(n) && !isPreop(n)) unclear.push(n)
  }
  for (const n of unclear) {
    const s = slots.find((x) => x.required && !taken(x.id))
    if (s) out[s.id] = n
  }
  return out
}

export interface ScanStats {
  triangles: number
  /** Bounding-box size, mm. */
  size: [number, number, number]
  min: [number, number, number]
  max: [number, number, number]
}

export interface ScanCheck {
  /** A short description of what was loaded ("Full arch, 61 × 52 × 21 mm, 412k triangles"). */
  summary: string
  warnings: string[]
}

/** Sanity checks on one uploaded scan against the slot it was put in. */
export function checkScan(name: string, stats: ScanStats, slot: ScanSlot): ScanCheck {
  const warnings: string[] = []
  const [a, b, c] = [...stats.size].sort((x, y) => y - x)
  let kind = 'Scan'
  if (a < 1) warnings.push('This scan is under 1 mm across — it was probably exported in metres. Re-export it in millimetres.')
  else if (a > 250) warnings.push(`This scan is ${a.toFixed(0)} mm across — far bigger than a jaw. Check the export units (mm).`)
  else if (a >= 35) kind = 'Full arch'
  else if (a >= 14) kind = 'Partial arch (quadrant)'
  else {
    kind = 'Single tooth or die'
    if (slot.id === 'prep' || slot.id === 'antagonist') warnings.push('This is smaller than a quadrant. The design needs the arch with the neighbouring teeth, not a single die.')
  }
  if (stats.triangles < 5000) warnings.push('Very few triangles — this looks like a low-resolution or decimated export.')
  const named = jawInName(name)
  if (slot.jaw && named && named !== slot.jaw && (slot.id === 'prep' || slot.id === 'antagonist'))
    warnings.push(`The file name says ${named.toUpperCase()} jaw, but this step needs the ${slot.jaw.toUpperCase()} jaw.`)
  if (isCrown(name)) warnings.push('The file name looks like a designed crown, not a scan.')
  if (slot.id !== 'bite' && isBite(name)) warnings.push('The file name looks like a bite scan.')
  const tri = stats.triangles >= 1000 ? `${Math.round(stats.triangles / 1000)}k` : String(stats.triangles)
  return { summary: `${kind} · ${a.toFixed(0)} × ${b.toFixed(0)} × ${c.toFixed(0)} mm · ${tri} triangles`, warnings }
}

/** Gap between two scans' bounding boxes, mm (0 when they overlap). */
export function boxGap(p: ScanStats, q: ScanStats): number {
  let s = 0
  for (let k = 0; k < 3; k++) {
    const d = Math.max(0, p.min[k] - q.max[k], q.min[k] - p.max[k])
    s += d * d
  }
  return Math.sqrt(s)
}

/** Opposing arches exported from one session overlap in plan view and touch. */
export function occlusionWarning(prep: ScanStats, ant: ScanStats): string | null {
  const gap = boxGap(prep, ant)
  if (gap > 3) return `The two arches are ${gap.toFixed(0)} mm apart, not in the bite. Export both jaws from the same scan session (in occlusion), or the contacts can't be designed.`
  return null
}

/* ── exocad .dentalProject import ────────────────────────────────────── */

export interface ProjectTooth {
  fdi: number
  universal: number | null
  type: string
  material: string
  role: 'restoration' | 'antagonist' | 'neighbour'
}

/** Reads an exocad `.dentalProject` (Treatment → Teeth → Tooth) order. */
export function parseDentalProject(xml: string): ProjectTooth[] {
  const teeth: ProjectTooth[] = []
  const tag = (block: string, name: string): string => new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1]?.trim() ?? ''
  for (const m of xml.matchAll(/<Tooth>([\s\S]*?)<\/Tooth>/g)) {
    const fdi = Number(tag(m[1], 'Number'))
    if (!fdi) continue
    const type = tag(m[1], 'ReconstructionType')
    const material = tag(m[1], 'MaterialName') || tag(m[1], 'Material')
    const healthy = /healthy|^ht$|adjacent|neighbo/i.test(material) || /^(LibraryTooth|Healthy|Adjacent)$/i.test(type)
    const role = /antagonist/i.test(type + material) ? 'antagonist' : healthy ? 'neighbour' : 'restoration'
    teeth.push({ fdi, universal: fdiToUniversal(fdi), type, material, role })
  }
  return teeth
}

/** Fills an order from an exocad project: first restoration tooth, its type and material. */
export function orderFromProject(teeth: ProjectTooth[], base: CaseOrder): { order: CaseOrder; note: string } {
  const r = teeth.filter((t) => t.role === 'restoration' && t.universal !== null)
  if (!r.length) return { order: base, note: `The project lists ${teeth.length} teeth but no restoration — pick the tooth.` }
  const t = r[0]
  const type = t.type.toLowerCase()
  const restoration: RestorationType = /coping|framework|reduced/.test(type)
    ? 'coping'
    : /pontic/.test(type)
      ? 'pontic'
      : /inlay/.test(type)
        ? 'inlay'
        : /onlay/.test(type)
          ? 'onlay'
          : /veneer/.test(type)
            ? 'veneer'
            : /implant|abutment/.test(type)
              ? 'implantCrown'
              : 'crown'
  const mat = t.material.toLowerCase()
  const material: MaterialId = /disilicate|e\.?max|lithium/.test(mat)
    ? 'lithium-disilicate'
    : /pmma|temp|provisional/.test(mat)
      ? 'pmma-temp'
      : /wax|gold|cast|metal/.test(mat)
        ? 'cast-wax'
        : /zirc/.test(mat) && /ht|transl|5y|ml/.test(mat)
          ? 'zirconia-ht'
          : /zirc/.test(mat)
            ? 'zirconia-hs'
            : base.material
  const more = r.length > 1 ? ` The project has ${r.length} restorations; one crown per case for now, starting with #${t.universal}.` : ''
  return {
    order: { ...base, tooth: t.universal, restoration, material, antagonist: base.antagonist || teeth.some((x) => x.role === 'antagonist') },
    note: `From the exocad project: #${t.universal} (FDI ${t.fdi}), ${t.type || 'crown'}, ${t.material || 'material not set'}.${more}`
  }
}
