import type * as THREE from 'three'
import { clamp, smoothstep, type Vec3 } from './geom'
import { createGrid, getP, gridNormal, marginDistances, setP, type CrownGrid } from './grid'
import { arcLengths, axisFrame, RadialSlicer, resample, type ProfilePoint } from './slice'

/**
 * The intaglio — the crown's fitting surface. It is the prep surface inside
 * the margin, (1) re-sampled on the crown grid so it shares the margin row
 * with the outer surface, (2) blocked out along the insertion axis so the
 * crown can seat (no undercuts), and (3) offset by the cement gap, which
 * fades in above a cement-free band at the margin so the margin seals.
 *
 * Works in tooth-local coordinates (insertion axis = +y).
 */

export interface IntaglioParams {
  cementGapMm: number
  /** Width of the band above the margin with no (or minimal) cement gap. */
  marginBandMm: number
  /** Gap inside that band (0 = metal-to-tooth seal; 0.01–0.02 is common). */
  marginGapMm: number
}

export interface IntaglioResult {
  grid: CrownGrid
  /** Undercut volume blocked out along the insertion axis, mm³. */
  blockoutVolumeMm3: number
  /** Deepest single undercut blocked out, mm. */
  maxUndercutMm: number
  /** Meridians where the prep profile could not be traced (filled from neighbours). */
  failedMeridians: number
}

export function buildIntaglio(
  prepLocal: THREE.BufferGeometry,
  marginRow: Vec3[],
  nv: number,
  params: IntaglioParams
): IntaglioResult {
  const nu = marginRow.length
  const grid = createGrid(nu, nv)
  const frame = axisFrame([0, 0, 0], [0, 1, 0], [0, 0, 1])
  const hMin = Math.min(...marginRow.map((p) => p[1])) - 1.5
  const slicer = new RadialSlicer(prepLocal, frame, 9, hMin, 20)
  const ok: boolean[] = []
  const poleHs: number[] = []
  for (let i = 0; i < nu; i++) {
    const th = (2 * Math.PI * i) / nu
    const m = marginRow[i]
    const mr = m[0] * Math.sin(th) + m[2] * Math.cos(th)
    const mh = m[1]
    const lines = slicer.slice(th)
    let best: { line: ProfilePoint[]; idx: number; d: number } | null = null
    for (const l of lines) {
      if (l[0].r > 1.5) continue
      for (let k = 0; k < l.length; k++) {
        const d = Math.hypot(l[k].r - mr, l[k].h - mh)
        if (!best || d < best.d) best = { line: l, idx: k, d }
      }
    }
    if (!best || best.d > 0.6) {
      ok.push(false)
      continue
    }
    const seg = best.line.slice(0, best.idx + 1).reverse()
    seg[0] = { r: mr, h: mh }
    poleHs.push(seg[seg.length - 1].h)
    // Close to the axis exactly.
    seg.push({ r: 0, h: seg[seg.length - 1].h })
    const dense = resample(seg, 0.04)
    const sl = arcLengths(dense)
    const total = sl[sl.length - 1]
    let k = 0
    for (let j = 0; j < nv; j++) {
      const target = (total * j) / nv
      while (k < dense.length - 2 && sl[k + 1] < target) k++
      const t = clamp((target - sl[k]) / Math.max(1e-9, sl[k + 1] - sl[k]), 0, 1)
      const r = dense[k].r + (dense[k + 1].r - dense[k].r) * t
      const h = dense[k].h + (dense[k + 1].h - dense[k].h) * t
      setP(grid, i, j, j === 0 ? m : [r * Math.sin(th), h, r * Math.cos(th)])
    }
    ok.push(true)
  }
  // Fill untraceable meridians from their neighbours (scan holes).
  let failed = 0
  for (let i = 0; i < nu; i++) {
    if (ok[i]) continue
    failed++
    let a = i
    let b = i
    while (!ok[(a + nu) % nu] && a > i - nu) a--
    while (!ok[b % nu] && b < i + nu) b++
    if (!ok[(a + nu) % nu] || !ok[b % nu]) continue
    const t = (i - a) / (b - a)
    for (let j = 0; j < nv; j++) {
      const pa = getP(grid, a, j)
      const pb = getP(grid, b, j)
      setP(grid, i, j, j === 0 ? marginRow[i] : [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t])
    }
  }
  grid.pole = [0, poleHs.length ? poleHs.reduce((s, h) => s + h, 0) / poleHs.length : 4, 0]

  // Blockout: walking each meridian from the occlusal pole toward the margin,
  // the distance from the insertion axis may never shrink.
  let blockout = 0
  let maxUndercut = 0
  for (let i = 0; i < nu; i++) {
    let rMax = 0
    for (let j = nv - 1; j >= 1; j--) {
      const p = getP(grid, i, j)
      const r = Math.hypot(p[0], p[2])
      if (r < rMax - 1e-6 && r > 1e-6) {
        const depth = rMax - r
        maxUndercut = Math.max(maxUndercut, depth)
        const s = rMax / r
        setP(grid, i, j, [p[0] * s, p[1], p[2] * s])
        // Area element ≈ (2πr/nu) × row spacing.
        const pn = getP(grid, i, j - 1)
        const rowLen = Math.hypot(p[0] - pn[0], p[1] - pn[1], p[2] - pn[2])
        blockout += depth * ((2 * Math.PI * rMax) / nu) * rowLen
      } else rMax = Math.max(rMax, r)
    }
  }

  // Cement space: offset along the prep's outward normal, fading in above the band.
  const sMargin = marginDistances(grid)
  const offsets: Vec3[] = []
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      if (j === 0) {
        offsets.push([0, 0, 0])
        continue
      }
      const s = sMargin[j * nu + i]
      const gap = params.marginGapMm + (params.cementGapMm - params.marginGapMm) * smoothstep(params.marginBandMm, params.marginBandMm + 0.5, s)
      const n = gridNormal(grid, i, j)
      offsets.push([n[0] * gap, n[1] * gap, n[2] * gap])
    }
  }
  for (let j = 1; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const p = getP(grid, i, j)
      const o = offsets[j * nu + i]
      setP(grid, i, j, [p[0] + o[0], p[1] + o[1], p[2] + o[2]])
    }
  }
  grid.pole = [grid.pole[0], grid.pole[1] + params.cementGapMm, grid.pole[2]]
  return { grid, blockoutVolumeMm3: blockout, maxUndercutMm: maxUndercut, failedMeridians: failed }
}
