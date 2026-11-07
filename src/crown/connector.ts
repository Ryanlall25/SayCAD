/**
 * Bridge connector rules, shared by the engine (which sizes and checks
 * connectors) and the studio (which draws their cross-sections), so both
 * judge a connector the same way.
 */

/** Ellipses are cut 6 % over: the mesh's facets take a little off the area. */
export const CONNECTOR_OVERSIZE = 1.06
/** Smallest acceptable section (mm²); the lab's own run 6–8 mm² where the bite leaves ~2 mm. */
export const CONNECTOR_MIN_MM2 = 6
/** Under this the gum is tight to clean beneath (mm). */
export const CONNECTOR_CLEAN_MM = 1

export interface ConnectorSection {
  widthMm: number
  heightMm: number
  targetMm2: number
  gumClearanceMm: number | null
  biteClearanceMm: number | null
}

/** The connector's effective cross-section (mm²): the ellipse less the facet allowance. */
export function connectorAreaMm2(k: Pick<ConnectorSection, 'widthMm' | 'heightMm'>): number {
  return ((Math.PI / 4) * k.widthMm * k.heightMm) / CONNECTOR_OVERSIZE
}

export type ConnectorVerdict = 'ok' | 'borderline' | 'fail'

/**
 * Traffic light for one connector. fail: under the minimum area, into the
 * gum, or into the bite past the clearance; borderline: under the target
 * area or tight to the gum; ok otherwise.
 */
export function connectorVerdict(k: ConnectorSection, occlusalClearanceMm: number): { verdict: ConnectorVerdict; reasons: string[] } {
  const area = connectorAreaMm2(k)
  const fail: string[] = []
  const warn: string[] = []
  if (area < CONNECTOR_MIN_MM2 - 0.05) fail.push(`${area.toFixed(1)} mm² is under the ${CONNECTOR_MIN_MM2} mm² minimum`)
  else if (area < k.targetMm2 - 0.05) warn.push(`${area.toFixed(1)} mm² is under the ${k.targetMm2} mm² target`)
  if (k.gumClearanceMm !== null && k.gumClearanceMm < 0) fail.push(`${(-k.gumClearanceMm).toFixed(1)} mm into the gum`)
  else if (k.gumClearanceMm !== null && k.gumClearanceMm < CONNECTOR_CLEAN_MM) warn.push(`only ${k.gumClearanceMm.toFixed(1)} mm over the gum`)
  if (k.biteClearanceMm !== null && k.biteClearanceMm < occlusalClearanceMm - 0.05) fail.push(`${(occlusalClearanceMm - k.biteClearanceMm).toFixed(2)} mm into the bite`)
  return { verdict: fail.length ? 'fail' : warn.length ? 'borderline' : 'ok', reasons: [...fail, ...warn] }
}
