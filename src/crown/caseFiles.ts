/**
 * Case-file role detection: which scan is the prep arch, which the
 * antagonist, which the finished crown. Works from file names the way
 * 3Shape / exocad / Medit exports are usually named, using the tooth number
 * to decide whether "upper" or "lower" is the prep side. An explicit
 * case.json always wins over guessing.
 */

export type FileRole = 'prep' | 'antagonist' | 'bite' | 'crown' | 'ignore'

export interface CaseManifest {
  toothNumber: number
  prep?: string
  antagonist?: string
  crown?: string
  material?: string
  notes?: string
}

const has = (name: string, re: RegExp): boolean => re.test(name.toLowerCase())

export function guessRole(fileName: string, toothNumber: number | null): FileRole {
  const n = fileName.toLowerCase()
  if (!/\.(stl|ply|obj)$/.test(n)) return 'ignore'
  if (has(n, /crown|restoration|design|anatomy|coping|\bcad\b/)) return 'crown'
  if (has(n, /antag|oppos/)) return 'antagonist'
  if (has(n, /bite|occlusion|buccal[-_ ]?scan/)) return 'bite'
  if (has(n, /prep|preparation|\bdie\b|abutment|stump/)) return 'prep'
  const upper = has(n, /upper|maxill|(^|[-_ ])u(pper)?jaw|(^|[-_ ])up([-_ .]|$)/)
  const lower = has(n, /lower|mandib|(^|[-_ ])l(ower)?jaw|(^|[-_ ])low([-_ .]|$)/)
  if (toothNumber !== null && (upper || lower)) {
    const prepUpper = toothNumber <= 16
    return upper === prepUpper ? 'prep' : 'antagonist'
  }
  return 'ignore'
}

/** Assigns roles to a set of files; manifest entries override guesses. */
export function assignRoles(fileNames: string[], manifest: Partial<CaseManifest> = {}): Record<string, FileRole> {
  const tooth = manifest.toothNumber ?? toothFromNames(fileNames)
  const out: Record<string, FileRole> = {}
  for (const f of fileNames) out[f] = guessRole(f, tooth)
  for (const key of ['prep', 'antagonist', 'crown'] as const) {
    const f = manifest[key]
    if (!f) continue
    for (const k of Object.keys(out)) if (out[k] === key) out[k] = 'ignore'
    out[f] = key
  }
  return out
}

/** "…_19_…", "tooth19", "#19" → 19 (Universal). */
export function toothFromNames(fileNames: string[]): number | null {
  for (const f of fileNames) {
    const m = /(?:tooth|#|[-_ ])(\d{1,2})(?=[-_ .]|$)/i.exec(f)
    if (m) {
      const n = Number(m[1])
      if (n >= 1 && n <= 32) return n
    }
  }
  return null
}
