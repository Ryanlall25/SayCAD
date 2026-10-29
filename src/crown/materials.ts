/**
 * Restoration material presets. The numbers are typical published minimums
 * for single posterior crowns. They are a starting point, NOT a substitute
 * for the instructions for use of the exact puck/block the lab mills: every
 * lab must confirm these against its own materials' IFUs and edit them here.
 */

export type MaterialId = 'zirconia-hs' | 'zirconia-ht' | 'lithium-disilicate' | 'pmma-temp' | 'cast-wax'

export interface MaterialPreset {
  id: MaterialId
  label: string
  /** Minimum wall thickness on axial walls, mm. */
  minAxialMm: number
  /** Minimum thickness under the occlusal surface, mm. */
  minOcclusalMm: number
  /** Cement space on the intaglio, mm. */
  cementGapMm: number
  /** Thickness right at the margin before the ramp to full thickness, mm. */
  marginThicknessMm: number
  note: string
}

export const MATERIALS: Record<MaterialId, MaterialPreset> = {
  'zirconia-hs': {
    id: 'zirconia-hs',
    label: 'Zirconia (high-strength, 3Y/4Y)',
    minAxialMm: 0.5,
    // SmileHub's lab minimum (its technicians' crowns go to 0.42–0.65 mm over
    // under-reduced preps); many 4Y pucks state more — confirm per puck IFU.
    minOcclusalMm: 0.5,
    cementGapMm: 0.06,
    marginThicknessMm: 0.1,
    note: 'Lab minimum 0.5 mm axial and occlusal for monolithic 3Y/4Y; confirm against the puck IFU.'
  },
  'zirconia-ht': {
    id: 'zirconia-ht',
    label: 'Zirconia (high-translucency, 5Y)',
    minAxialMm: 0.8,
    minOcclusalMm: 1.0,
    cementGapMm: 0.06,
    marginThicknessMm: 0.12,
    note: '5Y is weaker than 3Y/4Y and needs more bulk; confirm against the puck IFU.'
  },
  'lithium-disilicate': {
    id: 'lithium-disilicate',
    label: 'Lithium disilicate (e.g. e.max CAD)',
    minAxialMm: 1.5,
    minOcclusalMm: 1.5,
    cementGapMm: 0.07,
    marginThicknessMm: 0.15,
    note: 'Typical posterior monolithic crown minimums for conventional cementation; confirm against the block IFU.'
  },
  'pmma-temp': {
    id: 'pmma-temp',
    label: 'PMMA provisional',
    minAxialMm: 1.0,
    minOcclusalMm: 1.5,
    cementGapMm: 0.08,
    marginThicknessMm: 0.15,
    note: 'Provisional only.'
  },
  'cast-wax': {
    id: 'cast-wax',
    label: 'Wax/resin pattern for casting (full gold)',
    minAxialMm: 0.5,
    minOcclusalMm: 1.0,
    cementGapMm: 0.03,
    marginThicknessMm: 0.08,
    note: 'Pattern for a full-cast crown; casting shrinkage is the investment’s job, not this gap’s.'
  }
}

export function materialById(id: string): MaterialPreset | undefined {
  return (MATERIALS as Record<string, MaterialPreset>)[id]
}

/**
 * A material id from what a lab system writes ("Zirconia", "e.max CAD",
 * "PMMA"…). Plain zirconia maps to high-strength; null when unknown.
 */
export function materialFromText(text: string | undefined): MaterialId | null {
  if (!text) return null
  if (materialById(text)) return text as MaterialId
  const t = text.toLowerCase()
  if (/zirc|zr|zro2/.test(t)) return /5y|ht\b|high[- ]?transl|translucen|multilayer/.test(t) ? 'zirconia-ht' : 'zirconia-hs'
  if (/e\.?max|disilicate|lithium/.test(t)) return 'lithium-disilicate'
  if (/pmma|temp|provisional/.test(t)) return 'pmma-temp'
  if (/wax|cast|gold/.test(t)) return 'cast-wax'
  return null
}
