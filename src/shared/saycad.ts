/**
 * SayCAD design-document format — the JSON persisted into a case's file set
 * (category 'design', file name `design_vN.saycad.json`). Framework-free:
 * transforms are raw 16-number column-major arrays (same layout as
 * THREE.Matrix4.toArray()), never live three.js objects. Scans are NEVER part
 * of the document — they are reference geometry resolved from the case's own
 * tagged upper/lower/bite files at load time.
 */

export const SAYCAD_DOC_VERSION = 1

/** Suffix every design save carries; version prefix varies (design_v3....). */
export const SAYCAD_FILE_SUFFIX = '.saycad.json'

export type DesignObjectKind = 'tooth' | 'waxup' | 'mesh'

export interface DesignObjectDoc {
  id: string
  kind: DesignObjectKind
  /** Universal numbering 1–32 — set for kind 'tooth'. */
  toothNumber?: number
  /** Column-major 4x4 world transform (THREE.Matrix4.toArray layout). */
  transform: number[]
  /** For kind 'mesh': case-file id of the imported source mesh, so reopening
   *  can re-read the geometry bytes from case storage. */
  sourceFileId?: string
  /** Human-readable origin (library label or imported file name). */
  sourceName?: string
}

export interface SayCADDesignDoc {
  version: number
  savedAt: string
  objects: DesignObjectDoc[]
}

export function designFileName(version: number): string {
  return `design_v${version}${SAYCAD_FILE_SUFFIX}`
}

/** Extracts N from `design_vN.saycad.json`; null for any other file name. */
export function designVersionOf(fileName: string): number | null {
  const match = /^design_v(\d+)\.saycad\.json$/i.exec(fileName)
  return match ? Number(match[1]) : null
}

/** Next save version given the case's existing file names (v1 when none). */
export function nextDesignVersion(fileNames: string[]): number {
  let max = 0
  for (const name of fileNames) {
    const v = designVersionOf(name)
    if (v !== null && v > max) max = v
  }
  return max + 1
}

/**
 * Validating parse. Returns null instead of throwing on malformed input —
 * a corrupt design file should surface as "couldn't load design", never crash
 * the editor. Unknown future versions are rejected here so callers can show a
 * meaningful message.
 */
export function parseDesignDoc(json: string): SayCADDesignDoc | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const doc = raw as Record<string, unknown>
  if (doc.version !== SAYCAD_DOC_VERSION) return null
  if (!Array.isArray(doc.objects)) return null
  const objects: DesignObjectDoc[] = []
  for (const entry of doc.objects) {
    if (typeof entry !== 'object' || entry === null) return null
    const o = entry as Record<string, unknown>
    if (typeof o.id !== 'string' || o.id.length === 0) return null
    if (o.kind !== 'tooth' && o.kind !== 'waxup' && o.kind !== 'mesh') return null
    if (
      !Array.isArray(o.transform) ||
      o.transform.length !== 16 ||
      o.transform.some((n) => typeof n !== 'number' || !Number.isFinite(n))
    ) {
      return null
    }
    objects.push({
      id: o.id,
      kind: o.kind,
      toothNumber: typeof o.toothNumber === 'number' ? o.toothNumber : undefined,
      transform: o.transform as number[],
      sourceFileId: typeof o.sourceFileId === 'string' ? o.sourceFileId : undefined,
      sourceName: typeof o.sourceName === 'string' ? o.sourceName : undefined
    })
  }
  return {
    version: SAYCAD_DOC_VERSION,
    savedAt: typeof doc.savedAt === 'string' ? doc.savedAt : '',
    objects
  }
}
