import { normalize, sub, SurfaceIndex, type Vec3 } from './geom'
import { angleDiff, forEachVertex, getP, gridNormal, marginDistances, type CrownGrid } from './grid'
import type { WatertightReport } from './solid'

/**
 * Computable critics — the QC pass every design must clear before export.
 * Each critic measures one property on the finished geometry (never on the
 * intent), compares it with the requirement, and says what to do if it
 * fails. `fail` blocks export; `warn` needs a person to look.
 */

export type Verdict = 'pass' | 'warn' | 'fail'

export interface CriticResult {
  id: string
  label: string
  verdict: Verdict
  measured: string
  required: string
  message: string
  /** Suggested next action, phrased for the technician (and the AI layer). */
  fix?: string
}

export interface CriticInputs {
  outer: CrownGrid
  intaglioIndex: SurfaceIndex
  intaglioPoleY: number
  mesial: SurfaceIndex | null
  distal: SurfaceIndex | null
  antagonist: SurfaceIndex | null
  watertight: WatertightReport
  material: { minAxialMm: number; minOcclusalMm: number; marginThicknessMm: number; label: string }
  targets: { contactMesialMm: number; contactDistalMm: number; occlusalClearanceMm: number }
  marginConfidenceLowFraction: number
  marginMissingFraction: number
  /** The margin was traced at the gum line, not a visible finish line. */
  marginGumLine?: boolean
  buccalConfidence: number
  maxUndercutMm: number
  blockoutVolumeMm3: number
  openContacts: Array<{ side: 'mesial' | 'distal'; gapMm: number }>
}

export interface CriticReport {
  results: CriticResult[]
  exportable: boolean
  /** Per-outer-vertex wall thickness, mm (NaN in the margin band). */
  thickness: Float64Array
  summary: {
    minAxialThicknessMm: number
    minOcclusalThicknessMm: number
    mesialContactMm: number | null
    distalContactMm: number | null
    occlusalMinMm: number | null
    occlusalContactPoints: number
  }
}

const fmt = (x: number | null, d = 2): string => (x === null || !Number.isFinite(x) ? '—' : `${x.toFixed(d)} mm`)

export function runCritics(c: CriticInputs): CriticReport {
  const results: CriticResult[] = []
  const g = c.outer
  const s = marginDistances(g)
  const centre: Vec3 = [0, c.intaglioPoleY * 0.45, 0]

  // Watertight / manifold.
  const w = c.watertight
  results.push({
    id: 'watertight',
    label: 'Closed, manifold solid',
    verdict: w.watertight && w.volumeMm3 > 0 ? 'pass' : 'fail',
    measured: w.watertight ? `closed, ${w.volumeMm3.toFixed(1)} mm³` : `${w.boundaryEdges} open / ${w.nonManifoldEdges} non-manifold / ${w.inconsistentEdges} flipped edges`,
    required: 'closed 2-manifold, outward normals',
    message: w.watertight ? 'Mesh is millable/printable as a single solid.' : 'Mesh is not a closed solid — CAM will reject it.',
    fix: w.watertight ? undefined : 'Re-run auto design; if it persists, report the case.'
  })

  // Thickness.
  const thickness = new Float64Array(g.nu * g.nv).fill(NaN)
  let minAx = Infinity
  let minOcc = Infinity
  let thinAx = 0
  let thinOcc = 0
  let negative = 0
  forEachVertex(g, (i, j, p) => {
    if (j === 0) return
    const sd = c.intaglioIndex.signedDistance(p, normalize(sub(centre, p)), 6)
    // Axial wall: inside the prep when a ray straight out from the axis still
    // meets the fitting surface (the ray toward the centre misreads points
    // just above the margin). Occlusal table: the centre ray.
    if (j < g.nv * 0.4) {
      const r = Math.hypot(p[0], p[2])
      if (r > 1e-6 && c.intaglioIndex.raycast(p, [p[0] / r, 0, p[2] / r], 0.01, 6)) negative++
    } else if (sd < -0.01) negative++
    if (s[j * g.nu + i] < 1.0) return
    thickness[j * g.nu + i] = sd
    const n = gridNormal(g, i, j)
    const occ = n[1] > 0.55 || j > g.nv * 0.6
    if (occ) {
      minOcc = Math.min(minOcc, sd)
      if (sd < c.material.minOcclusalMm - 0.02) thinOcc++
    } else {
      minAx = Math.min(minAx, sd)
      if (sd < c.material.minAxialMm - 0.02) thinAx++
    }
  })
  results.push({
    id: 'thickness-axial',
    label: 'Axial wall thickness',
    verdict: thinAx === 0 ? 'pass' : 'fail',
    measured: fmt(minAx),
    required: `≥ ${c.material.minAxialMm} mm (${c.material.label})`,
    message: thinAx === 0 ? 'Axial walls meet the material minimum.' : `${thinAx} spot(s) thinner than the minimum.`,
    fix: thinAx ? 'Increase contour on the thin wall, or choose a material with a lower minimum.' : undefined
  })
  results.push({
    id: 'thickness-occlusal',
    label: 'Occlusal thickness',
    verdict: thinOcc === 0 ? 'pass' : 'fail',
    measured: fmt(minOcc),
    required: `≥ ${c.material.minOcclusalMm} mm`,
    message: thinOcc === 0 ? 'Occlusal table meets the material minimum.' : `${thinOcc} spot(s) under the minimum.`,
    fix: thinOcc ? 'Not enough occlusal reduction for this material: ask the doctor for more reduction, or switch material.' : undefined
  })
  if (negative > 0) {
    results.push({
      id: 'self-intersection',
      label: 'Outer surface clears the intaglio',
      verdict: 'fail',
      measured: `${negative} vertices inside the prep`,
      required: '0',
      message: 'Outer surface dips through the fitting surface.',
      fix: 'Re-run auto design; check the margin line in that area.'
    })
  }

  // Contacts.
  const contact = (n: SurfaceIndex | null, sign: 1 | -1): number | null => {
    if (!n) return null
    let min = Infinity
    const sideTheta = sign > 0 ? Math.PI / 2 : (3 * Math.PI) / 2
    forEachVertex(g, (i, j, p) => {
      if (j < 2 || angleDiff((2 * Math.PI * i) / g.nu, sideTheta) > (80 * Math.PI) / 180) return
      min = Math.min(min, n.signedDistance(p, [sign, 0, 0], 1.5))
    })
    return Number.isFinite(min) ? min : null
  }
  const mes = contact(c.mesial, 1)
  const dis = contact(c.distal, -1)
  const contactResult = (side: 'mesial' | 'distal', value: number | null, target: number): CriticResult => {
    if (value === null)
      return { id: `contact-${side}`, label: `${cap(side)} contact`, verdict: 'warn', measured: 'no neighbour', required: `${target.toFixed(2)} mm`, message: `No ${side} neighbour found in the scan — check if the tooth is missing.` }
    const err = value - target
    const verdict: Verdict = Math.abs(err) <= 0.03 ? 'pass' : err > 0.03 && err < 0.15 ? 'warn' : err >= 0.15 ? 'fail' : err < -0.08 ? 'fail' : 'warn'
    return {
      id: `contact-${side}`,
      label: `${cap(side)} contact`,
      verdict,
      measured: fmt(value, 3),
      required: `${target.toFixed(2)} ± 0.03 mm`,
      message: verdict === 'pass' ? 'Contact at target.' : err > 0 ? 'Contact is open.' : 'Contact is too tight.',
      fix: verdict === 'pass' ? undefined : err > 0 ? `Add ${err.toFixed(2)} mm at the ${side} contact.` : `Relieve ${(-err).toFixed(2)} mm at the ${side} contact.`
    }
  }
  results.push(contactResult('mesial', mes, c.targets.contactMesialMm))
  results.push(contactResult('distal', dis, c.targets.contactDistalMm))
  for (const o of c.openContacts) {
    results.push({ id: `open-${o.side}`, label: `${cap(o.side)} space`, verdict: 'warn', measured: fmt(o.gapMm), required: 'reachable', message: `The ${o.side} neighbour is too far to contact (diastema or drifted tooth).`, fix: 'Confirm with the Rx whether an open contact is intended.' })
  }

  // Occlusion.
  let occMin: number | null = null
  let occPoints = 0
  if (c.antagonist) {
    let m = Infinity
    forEachVertex(g, (_i, j, p) => {
      if (j < g.nv * 0.3) return
      const sd = c.antagonist!.gapUp(p, 2)
      m = Math.min(m, sd)
      if (sd < c.targets.occlusalClearanceMm + 0.1) occPoints++
    })
    occMin = m
    const err = m - c.targets.occlusalClearanceMm
    const verdict: Verdict = err < -0.05 ? 'fail' : err > 0.3 ? 'warn' : 'pass'
    results.push({
      id: 'occlusion',
      label: 'Occlusal clearance',
      verdict,
      measured: fmt(m, 3),
      required: `≥ ${c.targets.occlusalClearanceMm.toFixed(2)} mm, in contact`,
      message: verdict === 'fail' ? 'Crown is high — it hits the antagonist.' : verdict === 'warn' ? 'Crown is out of occlusion (no stops).' : `${occPoints} vertices within the occlusal contact zone.`,
      fix: verdict === 'fail' ? 'Usually a thickness/occlusion conflict: see occlusal thickness.' : verdict === 'warn' ? 'Raise the occlusal table or enable occlusal contacts.' : undefined
    })
  } else {
    results.push({ id: 'occlusion', label: 'Occlusal clearance', verdict: 'warn', measured: 'no antagonist', required: 'antagonist scan', message: 'No antagonist loaded — occlusion was not designed.', fix: 'Load the opposing (and bite) scan.' })
  }

  // Seating.
  results.push({
    id: 'undercut',
    label: 'Prep undercuts',
    verdict: c.maxUndercutMm > 0.35 ? 'warn' : 'pass',
    measured: `${c.maxUndercutMm.toFixed(2)} mm deep, ${c.blockoutVolumeMm3.toFixed(2)} mm³ blocked out`,
    required: 'blocked out along the insertion axis',
    message: c.maxUndercutMm > 0.35 ? 'Significant undercut blocked out — the crown will have extra cement space there.' : 'Seats along the insertion axis.',
    fix: c.maxUndercutMm > 0.35 ? 'Consider asking for a prep adjustment or re-tilting the insertion axis.' : undefined
  })

  // Inputs the person should eyeball.
  const marginOk = !c.marginGumLine && c.marginMissingFraction < 0.05 && c.marginConfidenceLowFraction < 0.15
  results.push({
    id: 'margin',
    label: 'Margin line',
    verdict: marginOk ? 'pass' : 'warn',
    measured: `${(100 * (1 - c.marginConfidenceLowFraction)).toFixed(0)}% high-confidence`,
    required: 'clear finish line',
    message: c.marginGumLine
      ? 'No finish line is visible (scan taken without retraction?) — the margin was traced where the prep meets the gum. Confirm it follows the finish line.'
      : marginOk
        ? 'Finish line found all the way round.'
        : 'Parts of the margin are uncertain — they are highlighted.',
    fix: marginOk ? undefined : 'Tap the highlighted section on the scan to move the margin there.'
  })
  results.push({
    id: 'orientation',
    label: 'Buccal direction',
    verdict: c.buccalConfidence >= 0.4 ? 'pass' : 'warn',
    measured: `${(c.buccalConfidence * 100).toFixed(0)}% confidence`,
    required: 'buccal faces the cheek',
    message: c.buccalConfidence >= 0.4 ? 'Orientation read from the arch curve.' : 'Short scan — confirm the buccal arrow points to the cheek.',
    fix: c.buccalConfidence >= 0.4 ? undefined : 'Use “flip buccal” if the arrow points to the tongue.'
  })

  return {
    results,
    exportable: !results.some((r) => r.verdict === 'fail'),
    thickness,
    summary: {
      minAxialThicknessMm: minAx,
      minOcclusalThicknessMm: minOcc,
      mesialContactMm: mes,
      distalContactMm: dis,
      occlusalMinMm: occMin,
      occlusalContactPoints: occPoints
    }
  }
}

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1)

/** Vertex thickness for an outer grid vertex (helper for colour maps). */
export function thicknessAt(report: CriticReport, g: CrownGrid, i: number, j: number): number {
  return report.thickness[j * g.nu + i]
}


