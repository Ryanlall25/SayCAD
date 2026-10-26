import { NEW_ORDER, assignToSlots, orderFromProject, parseDentalProject, scanSlots, type SlotId } from '../crown/order'
import { fdiToUniversal } from '../crown/library'
import { unzip } from '../core/unzip'
import { zip } from '../core/zip'
import { CONTRACT, type CrownJob, type CrownOrder, type CrownOutcome, type ScanInput } from './contract'

/**
 * Case bundles: how a job travels as files — over HTTP, on disk, from a
 * scanner export. A bundle is a set of files (or one .zip of them):
 *
 *   job.json            optional; CrownJob with scan *file names* in `scans`
 *   *.stl / *.ply / *.obj  the scans
 *   *.dentalProject     optional exocad order (tooth, material)
 *
 * Without job.json the scans are sorted by name (upper/lower, maxillary/
 * mandibular, bite, pre-op) against the tooth, as the phone does.
 */

export interface BundleFile {
  name: string
  data: ArrayBuffer
}

/** job.json inside a bundle: a CrownJob whose scans are file names. */
export interface BundleJob extends Omit<CrownJob, 'scans'> {
  scans?: { prep?: string; antagonist?: string; bite?: string[]; preop?: string }
}

const SCAN = /\.(stl|ply|obj)$/i
const base = (n: string): string => n.split(/[\\/]/).pop()!

/** Flattens zips; drops folders and junk (macOS resource forks). */
export async function expandBundle(files: BundleFile[]): Promise<BundleFile[]> {
  const out: BundleFile[] = []
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      for (const e of await unzip(f.data, (n) => !/(^|\/)__MACOSX\//.test(n) && !/(^|\/)\._/.test(n))) out.push({ name: base(e.name), data: e.data.buffer })
    } else out.push({ name: base(f.name), data: f.data })
  }
  return out
}

/**
 * Builds a CrownJob from bundle files. `order` (e.g. from the host's Rx or a
 * CLI flag) wins over job.json, which wins over a .dentalProject.
 */
export async function jobFromBundle(input: BundleFile[], order: Partial<CrownOrder> = {}, jobId?: string): Promise<{ job: CrownJob | null; problems: string[]; notes: string[] }> {
  const files = await expandBundle(input)
  const notes: string[] = []
  const text = (f: BundleFile): string => new TextDecoder().decode(f.data)
  const jj = files.find((f) => f.name.toLowerCase() === 'job.json')
  let fromJson: Partial<BundleJob> = {}
  if (jj) {
    try {
      fromJson = JSON.parse(text(jj)) as BundleJob
    } catch {
      return { job: null, problems: ['job.json is not valid JSON.'], notes }
    }
  }
  let fromProject: Partial<CrownOrder> = {}
  const dp = files.find((f) => /\.dentalProject$/i.test(f.name))
  if (dp) {
    const r = orderFromProject(parseDentalProject(text(dp)), { ...NEW_ORDER })
    if (r.order.tooth) fromProject = { tooth: r.order.tooth, system: 'universal', material: r.order.material }
    notes.push(r.note)
  }
  const merged: CrownOrder = { ...fromProject, ...fromJson.order, ...order } as CrownOrder
  if (typeof merged.tooth !== 'number') return { job: null, problems: ['Which tooth? Give order.tooth (in job.json, the request, or the Rx).'], notes }
  const universal = merged.system === 'fdi' ? fdiToUniversal(merged.tooth) : merged.tooth
  if (!universal) return { job: null, problems: [`Tooth ${merged.tooth} is not a valid ${merged.system ?? 'universal'} number.`], notes }

  const scanFiles = files.filter((f) => SCAN.test(f.name))
  const byName = (n?: string): BundleFile | undefined => (n ? scanFiles.find((f) => f.name === base(n)) : undefined)
  const named = fromJson.scans ?? {}
  const roles: Partial<Record<SlotId, string>> = {}
  if (named.prep) roles.prep = base(named.prep)
  if (named.antagonist) roles.antagonist = base(named.antagonist)
  if (!roles.prep || !roles.antagonist) {
    const slots = scanSlots({ ...NEW_ORDER, tooth: universal, antagonist: true })
    const guess = assignToSlots(scanFiles.map((f) => f.name).filter((n) => n !== roles.prep && n !== roles.antagonist), slots, roles)
    roles.prep ??= guess.prep
    roles.antagonist ??= guess.antagonist
  }
  const prep = byName(roles.prep)
  if (!prep) return { job: null, problems: [`No prep-arch scan found for tooth #${universal}. Name it e.g. "…lowerjaw.stl"/"…upperjaw.stl", or set scans.prep in job.json.`], notes }
  const ant = byName(roles.antagonist)
  if (!ant) notes.push('No opposing scan: contacts with the bite are not designed, and the prep must be located by the host.')
  const scan = (f: BundleFile): ScanInput => ({ name: f.name, data: f.data })
  const extra = scanFiles.filter((f) => f !== prep && f !== ant)
  const bite = (named.bite?.map(byName).filter(Boolean) as BundleFile[] | undefined) ?? extra.filter((f) => /bite|buccal/i.test(f.name))
  const preop = byName(named.preop) ?? extra.find((f) => /pre[-_ ]?op|situation|wax[-_ ]?up/i.test(f.name))
  const job: CrownJob = {
    contract: CONTRACT,
    jobId: jobId ?? fromJson.jobId ?? `job-${Date.now().toString(36)}`,
    order: { ...merged, tooth: universal, system: 'universal' },
    scans: { prep: scan(prep), ...(ant ? { antagonist: scan(ant) } : {}), ...(bite.length ? { bite: bite.map(scan) } : {}), ...(preop ? { preop: scan(preop) } : {}) },
    options: fromJson.options
  }
  return { job, problems: [], notes }
}

/** The outcome as JSON-safe data (binary files replaced by their names). */
export function outcomeJson(o: CrownOutcome): Omit<CrownOutcome, 'files'> & { files?: { crownStl: string; designRecord: string } } {
  const { files, ...rest } = o
  return files ? { ...rest, files: { crownStl: files.crownStlName, designRecord: 'design-record.json' } } : rest
}

/** The outcome as files: crown STL, outcome.json, design-record.json. */
export function outcomeFiles(o: CrownOutcome): Array<{ name: string; data: Uint8Array<ArrayBuffer> }> {
  const enc = (x: unknown): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify(x, null, 1)) as Uint8Array<ArrayBuffer>
  const out = [{ name: 'outcome.json', data: enc(outcomeJson(o)) }]
  if (o.files) {
    out.push({ name: o.files.crownStlName, data: new Uint8Array(o.files.crownStl) })
    out.push({ name: 'design-record.json', data: enc(o.files.designRecord) })
  }
  return out
}

export const outcomeZip = (o: CrownOutcome): Uint8Array<ArrayBuffer> => zip(outcomeFiles(o))
