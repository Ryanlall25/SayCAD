import * as THREE from 'three'
import {
  add,
  clamp,
  cross,
  dist,
  dot,
  forEachTriangle,
  len,
  normalize,
  pca3,
  scale,
  sub,
  SurfaceIndex,
  type Vec3
} from './geom'
import { arcLengths, axisFrame, profileToWorld, RadialSlicer, resample, smoothLine, type AxisFrame, type ProfilePoint } from './slice'

/**
 * Automatic margin-line detection on a prep scan.
 *
 * Input is the scan (welded) and one tap on the prep. The finder:
 *   1. estimates the occlusal direction from the surface around the tap and
 *      centres an axis line inside the stump (wall rays from inside);
 *   2. cuts K radial profiles around that axis (see slice.ts);
 *   3. reads each profile the way a technician does — the occlusal table,
 *      the axial wall, then the finish line: the first convex corner below
 *      the wall, preferably right after the concave chamfer/shoulder floor;
 *   4. keeps several candidates per profile and picks the globally smoothest
 *      closed loop by dynamic programming, so a single noisy profile (scan
 *      hole, blood, retraction cord) cannot drag the line off;
 *   5. re-centres the axis on the found loop and repeats once.
 *
 * Output carries a per-sample confidence so the UI can highlight the parts
 * of the line a person should look at before trusting it.
 */

export interface MarginOptions {
  samples?: number
  /** Search radius around the axis, mm. */
  radius?: number
  /** Known occlusal direction (skips estimation). */
  up?: Vec3
}

export interface MarginResult {
  /** Margin loop, world coordinates, one point per sample angle. */
  points: Vec3[]
  thetas: number[]
  /** Axis the profiles were cut around (origin on the axis, at margin height). */
  axis: AxisFrame
  /** 0–1 per sample; < 0.35 means "look at this part". */
  confidence: number[]
  /** Prep top (occlusal-most point on the axis), world. */
  top: Vec3
  /** Fraction of samples with no credible candidate (filled by interpolation). */
  missingFraction: number
}

interface Candidate {
  point: Vec3
  score: number
  r: number
  h: number
}

const DEG = Math.PI / 180

/** Area-weighted surface normal around p (sign fixed by the air-side test). */
export function estimateUp(scan: SurfaceIndex, p: Vec3, radius = 2.5): Vec3 {
  let n: Vec3 = [0, 0, 0]
  forEachTriangle(scan.geometry, (a, b, c) => {
    const cx = (a[0] + b[0] + c[0]) / 3
    const cy = (a[1] + b[1] + c[1]) / 3
    const cz = (a[2] + b[2] + c[2]) / 3
    if ((cx - p[0]) ** 2 + (cy - p[1]) ** 2 + (cz - p[2]) ** 2 > radius * radius) return
    n = add(n, cross(sub(b, a), sub(c, a)))
  })
  let up = normalize(n)
  if (len(up) === 0) up = [0, 1, 0]
  // Air-side test: occlusal of a prep is open air; the other way runs into
  // the stump/root. Winding is not trusted.
  const freeUp = !scan.raycast(add(p, scale(up, 0.05)), up, 0, 25)
  const freeDown = !scan.raycast(add(p, scale(up, -0.05)), scale(up, -1), 0, 25)
  if (!freeUp && freeDown) up = scale(up, -1)
  return up
}

/** Centres an axis line inside the stump by averaging wall hits of
 *  horizontal rays cast from inside. */
export function centreAxis(scan: SurfaceIndex, seed: Vec3, up: Vec3, depth = 1.2, iterations = 3): Vec3 {
  let c = sub(seed, scale(up, depth))
  const f = axisFrame(c, up)
  for (let it = 0; it < iterations; it++) {
    const hits: Vec3[] = []
    for (let k = 0; k < 48; k++) {
      const th = (k / 48) * Math.PI * 2
      const d = add(scale(f.ref, Math.cos(th)), scale(cross(up, f.ref), Math.sin(th)))
      const h = scan.raycast(c, d, 0, 8)
      if (h) hits.push(h.point)
    }
    if (hits.length < 16) break
    const m = hits.reduce((acc, p) => add(acc, scale(p, 1 / hits.length)), [0, 0, 0] as Vec3)
    // Keep the centre at the same height along the axis.
    c = add(m, scale(up, dot(sub(c, m), up)))
  }
  return c
}

/** Reads one radial profile and returns ranked finish-line candidates. */
export function profileCandidates(raw: ProfilePoint[], topH: number): Array<{ r: number; h: number; score: number }> {
  const step = 0.04
  const sampled = resample(raw, step)
  const line = smoothLine(sampled, 1.5)
  const n = line.length
  if (n < 20) return []
  const s = arcLengths(line)
  const alpha: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const a = line[Math.max(0, i - 2)]
    const b = line[Math.min(n - 1, i + 2)]
    alpha[i] = Math.atan2(b.h - a.h, b.r - a.r)
  }
  const L = 6
  const tau: number[] = new Array(n).fill(0)
  for (let i = L; i < n - L; i++) {
    let d = alpha[i + L] - alpha[i - L]
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    tau[i] = d
  }
  // The axial wall: first ≥ 0.8 mm run descending steeper than 55°.
  let wallStart = -1
  let runStart = -1
  for (let i = 0; i < n; i++) {
    if (alpha[i] < -55 * DEG && alpha[i] > -125 * DEG) {
      if (runStart < 0) runStart = i
      if (s[i] - s[runStart] >= 0.8) {
        wallStart = runStart
        break
      }
    } else runStart = -1
  }
  if (wallStart < 0) return []
  const out: Array<{ r: number; h: number; score: number; order: number }> = []
  const back = Math.round(1.2 / step)
  for (let i = Math.max(wallStart + 2, L + 1); i < n - L - 1; i++) {
    if (!(tau[i] < -0.45 && tau[i] <= tau[i - 1] && tau[i] <= tau[i + 1])) continue
    // Not too far below the prep top: margins sit within ~10 mm of it.
    if (topH - line[i].h > 10) continue
    let chamfer = 0
    for (let k = Math.max(wallStart, i - back); k < i; k++) chamfer = Math.max(chamfer, tau[k])
    // The coarse turning measure plateaus across a corner; locate the corner
    // itself as the centre of mass of the fine-scale convex turning around i.
    let wsum = 0
    let isum = 0
    for (let j = Math.max(1, i - 2 * L); j <= Math.min(n - 2, i + 2 * L); j++) {
      let d = alpha[j + 1] - alpha[j - 1]
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      const w = Math.max(0, -d)
      wsum += w
      isum += w * j
    }
    const at = wsum > 0 ? Math.round(isum / wsum) : i
    const p = sampled[clamp(at, 0, n - 1)]
    out.push({ r: p.r, h: p.h, score: -tau[i] + 0.6 * clamp(chamfer, 0, 2), order: out.length })
  }
  return out
    .map((c) => ({ r: c.r, h: c.h, score: c.score - 0.15 * c.order }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
}

/** Picks the main profile polyline: the one that starts over the prep top. */
function mainProfile(lines: ProfilePoint[][], topH: number): ProfilePoint[] | null {
  let best: ProfilePoint[] | null = null
  let bestScore = -Infinity
  for (const l of lines) {
    if (l[0].r > 1.5) continue
    const score = -Math.abs(l[0].h - topH) - l[0].r + 0.02 * l.length
    if (score > bestScore) {
      bestScore = score
      best = l
    }
  }
  return best
}

/** Smoothest closed loop through per-sector candidates (cyclic DP). */
function chooseLoop(cands: Candidate[][], spacing: number): { picks: number[]; missing: boolean[] } {
  const K = cands.length
  const MISSING_COST = 1.4
  const LAMBDA = 3
  const opts = cands.map((c) => c.length + 1) // last option = "missing"
  const unary = (k: number, j: number): number => (j === cands[k].length ? MISSING_COST : -cands[k][j].score)
  const pair = (k: number, j: number, k2: number, j2: number): number => {
    if (j === cands[k].length || j2 === cands[k2].length) return 0.25
    const d = dist(cands[k][j].point, cands[k2][j2].point)
    return LAMBDA * Math.max(0, d - spacing * 1.5)
  }
  let bestTotal = Infinity
  let bestPicks: number[] = new Array(K).fill(0)
  for (let j0 = 0; j0 < opts[0]; j0++) {
    const cost: number[][] = [Array.from({ length: opts[0] }, (_, j) => (j === j0 ? unary(0, j) : Infinity))]
    const from: number[][] = [new Array(opts[0]).fill(-1)]
    for (let k = 1; k < K; k++) {
      cost.push(new Array(opts[k]).fill(Infinity))
      from.push(new Array(opts[k]).fill(-1))
      for (let j = 0; j < opts[k]; j++) {
        for (let i = 0; i < opts[k - 1]; i++) {
          const c = cost[k - 1][i]
          if (c === Infinity) continue
          const v = c + pair(k - 1, i, k, j) + unary(k, j)
          if (v < cost[k][j]) {
            cost[k][j] = v
            from[k][j] = i
          }
        }
      }
    }
    for (let j = 0; j < opts[K - 1]; j++) {
      const total = cost[K - 1][j] + pair(K - 1, j, 0, j0)
      if (total < bestTotal) {
        bestTotal = total
        const picks = new Array(K)
        picks[K - 1] = j
        for (let k = K - 1; k > 0; k--) picks[k - 1] = from[k][picks[k]]
        bestPicks = picks
      }
    }
  }
  return { picks: bestPicks, missing: bestPicks.map((j, k) => j === cands[k].length) }
}

function detectOnce(
  scan: SurfaceIndex,
  centre: Vec3,
  up: Vec3,
  K: number,
  radius: number
): { result: MarginResult; ok: boolean } {
  // Prep top on the axis.
  const topHit = scan.raycast(add(centre, scale(up, 15)), scale(up, -1), 0, 30)
  const top = topHit ? topHit.point : add(centre, scale(up, 1.2))
  const frame = axisFrame(centre, up)
  const topH = dot(sub(top, centre), up)
  const slicer = new RadialSlicer(scan.geometry, frame, radius, topH - 12, topH + 3)
  const thetas: number[] = []
  const cands: Candidate[][] = []
  for (let k = 0; k < K; k++) {
    const th = (k / K) * Math.PI * 2
    thetas.push(th)
    const prof = mainProfile(slicer.slice(th), topH)
    const list = prof ? profileCandidates(prof, topH) : []
    cands.push(list.map((c) => ({ ...c, point: profileToWorld(frame, th, { r: c.r, h: c.h }) })))
  }
  const typicalR = median(cands.flatMap((c) => c.slice(0, 1).map((x) => x.r))) || 4
  const { picks, missing } = chooseLoop(cands, (2 * Math.PI * typicalR) / K)
  const points: Array<Vec3 | null> = picks.map((j, k) => (missing[k] ? null : cands[k][j].point))
  const scores = picks.map((j, k) => (missing[k] ? 0 : cands[k][j].score))
  const missingCount = points.filter((p) => !p).length
  if (missingCount > K * 0.5) {
    return {
      ok: false,
      result: { points: [], thetas, axis: frame, confidence: [], top, missingFraction: missingCount / K }
    }
  }
  const filled = fillGaps(points)
  const smooth = smoothLoop(filled, 2)
  // Snap back onto the surface after smoothing.
  const snapped = smooth.map((p) => scan.closest(p, 1)?.point ?? p)
  const conf = scores.map((s) => clamp(s / 1.6, 0, 1))
  return { ok: true, result: { points: snapped, thetas, axis: frame, confidence: conf, top, missingFraction: missingCount / K } }
}

/** Full margin detection from a single tap on the prep. */
export function detectMargin(scan: SurfaceIndex, tap: Vec3, opts: MarginOptions = {}): MarginResult {
  const K = opts.samples ?? 180
  const radius = opts.radius ?? 8
  let up = opts.up ? normalize(opts.up) : estimateUp(scan, tap)
  let centre = centreAxis(scan, tap, up)
  let { result, ok } = detectOnce(scan, centre, up, K, radius)
  if (!ok) return result
  // Re-centre on the found loop, re-estimate the axis, cut again.
  for (let pass = 0; pass < 2; pass++) {
    const fit = pca3(result.points)
    let n = fit.axes[0]
    if (dot(n, up) < 0) n = scale(n, -1)
    // Margin-plane normal and the occlusal estimate are both noisy in
    // different ways (scalloped margins tilt the plane); average them.
    if (!opts.up) up = normalize(add(scale(up, 0.5), scale(n, 0.5)))
    const m = fit.mean
    centre = add(m, scale(up, dot(sub(result.top, m), up) * 0.45))
    const again = detectOnce(scan, centre, up, K, radius)
    if (!again.ok) break
    result = again.result
  }
  return result
}

function fillGaps(points: Array<Vec3 | null>): Vec3[] {
  const K = points.length
  const known = points.map((p, i) => (p ? i : -1)).filter((i) => i >= 0)
  return points.map((p, i) => {
    if (p) return p
    let prev = known[0]
    let next = known[0]
    for (const k of known) if (k < i) prev = k
    for (const k of [...known].reverse()) if (k > i) next = k
    if (prev > i) prev = known[known.length - 1]
    if (next < i) next = known[0]
    const span = (next - prev + K) % K || K
    const t = ((i - prev + K) % K) / span
    const a = points[prev]!
    const b = points[next]!
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
  })
}

/** Cyclic moving-average smoothing (window = 2·w + 1). */
export function smoothLoop(points: Vec3[], w: number): Vec3[] {
  const K = points.length
  return points.map((_, i) => {
    const acc: Vec3 = [0, 0, 0]
    for (let k = -w; k <= w; k++) {
      const p = points[(i + k + K) % K]
      acc[0] += p[0]
      acc[1] += p[1]
      acc[2] += p[2]
    }
    return scale(acc, 1 / (2 * w + 1))
  })
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * Moves the margin sample nearest `tapped` onto it and blends its
 * neighbours (Gaussian falloff over `radius` samples) — the one-finger
 * "fix this bit" margin edit on a phone.
 */
export function editMargin(points: Vec3[], tapped: Vec3, scan: SurfaceIndex, radius = 6): Vec3[] {
  const K = points.length
  let best = 0
  let bestD = Infinity
  points.forEach((p, i) => {
    const d = dist(p, tapped)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  const delta = sub(tapped, points[best])
  const out = points.map((p, i) => {
    let k = Math.abs(i - best)
    k = Math.min(k, K - k)
    const w = Math.exp(-(k * k) / (2 * (radius / 2) ** 2))
    return add(p, scale(delta, w))
  })
  return out.map((p) => scan.closest(p, 1.5)?.point ?? p)
}

/** Mean / max distance from each detected point to a reference polyline. */
export function marginError(detected: Vec3[], truth: Vec3[]): { mean: number; p95: number; max: number } {
  const d = detected.map((p) => {
    let m = Infinity
    for (let i = 0; i < truth.length; i++) {
      const a = truth[i]
      const b = truth[(i + 1) % truth.length]
      m = Math.min(m, pointSegment(p, a, b))
    }
    return m
  })
  const sorted = [...d].sort((a, b) => a - b)
  return {
    mean: d.reduce((s, x) => s + x, 0) / d.length,
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted[sorted.length - 1]
  }
}

function pointSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a)
  const t = clamp(dot(sub(p, a), ab) / Math.max(dot(ab, ab), 1e-12), 0, 1)
  return dist(p, add(a, scale(ab, t)))
}

/** Welded SurfaceIndex for a raw scan geometry. */
export function scanIndex(geometry: THREE.BufferGeometry): SurfaceIndex {
  return new SurfaceIndex(geometry)
}
