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
  /** Traced at the wall–gum crease (no visible finish line): a guess to confirm. */
  gumLine?: boolean
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
export function profileCandidates(raw: ProfilePoint[], topH: number, minTurn = 0.45, creases = false): Array<{ r: number; h: number; score: number }> {
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
  // Mean wall angle over the arc-length window [from, to] mm around i.
  const meanAlpha = (i: number, from: number, to: number): number => {
    let sum = 0
    let k = 0
    for (let j = Math.max(0, i + Math.floor(from / step) - 2); j < n && j <= i + Math.ceil(to / step) + 2; j++) {
      const d = s[j] - s[i]
      if (d < from || d > to) continue
      sum += alpha[j]
      k++
    }
    return k ? sum / k : 0
  }
  // Steepest descent within 0.4 mm below a corner.
  const steepAfter = (i: number): boolean => {
    for (let j = i + 1; j < n && s[j] - s[i] <= 0.4; j++) if (alpha[j] < -60 * DEG && alpha[j] > -150 * DEG) return true
    return false
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
  const out: Array<{ r: number; h: number; score: number; at: number; edge: boolean }> = []
  const back = Math.round(1.2 / step)
  for (let i = Math.max(wallStart + 2, L + 1); i < n - L - 1; i++) {
    if (!(tau[i] < -minTurn && tau[i] <= tau[i - 1] && tau[i] <= tau[i + 1])) continue
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
    // A finish line drops away steeply below its edge (root, or the die); a
    // corner that rolls over into a gentle slope is a gingival crest.
    const edge = steepAfter(at)
    out.push({ r: p.r, h: p.h, score: edge || !creases ? -tau[i] + 0.6 * clamp(chamfer, 0, 2) : 0.4 * -tau[i], at, edge })
  }
  // Scans taken without retraction: the gum hugs the prep and the finish
  // line is the crease where the axial wall meets it — a concave turn from
  // the steep wall onto the gentler gum, with no true edge just below.
  for (let i = Math.max(wallStart + 2, L + 1); creases && i < n - L - 1; i++) {
    if (!(tau[i] > minTurn && tau[i] >= tau[i - 1] && tau[i] >= tau[i + 1])) continue
    if (topH - line[i].h > 10) continue
    if (meanAlpha(i, -0.8, -0.15) > -55 * DEG || meanAlpha(i, 0.15, 0.8) < -50 * DEG) continue
    // A true edge just below makes this a chamfer/shoulder floor; one just
    // above makes it the root meeting the gum below the margin.
    if (out.some((c) => c.edge && Math.abs(s[c.at] - s[i]) < (c.at > i ? 1.2 : 2))) continue
    const q = sampled[i]
    out.push({ r: q.r, h: q.h, score: tau[i] + 0.3, at: i, edge: false })
  }
  // Earlier along the profile (nearer the prep top) wins ties.
  return out
    .sort((a, b) => a.at - b.at)
    .map((c, order) => ({ r: c.r, h: c.h, score: c.score - 0.15 * order }))
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

/** Least-squares Fourier series of order `order` through (θ, y), weighted. */
function fourierFit(th: number[], y: number[], w: number[], order: number): (t: number) => number {
  const basis = (t: number): number[] => {
    const b = [1]
    for (let o = 1; o <= order; o++) b.push(Math.cos(o * t), Math.sin(o * t))
    return b
  }
  const m = 1 + 2 * order
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0))
  for (let i = 0; i < th.length; i++) {
    if (!w[i]) continue
    const b = basis(th[i])
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) A[r][c] += w[i] * b[r] * b[c]
      A[r][m] += w[i] * b[r] * y[i]
    }
  }
  for (let r = 0; r < m; r++) A[r][r] += 1e-6
  for (let c = 0; c < m; c++) {
    let p = c
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]
    for (let r = 0; r < m; r++) {
      if (r === c || !A[c][c]) continue
      const f = A[r][c] / A[c][c]
      for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]
    }
  }
  const coef = A.map((row, r) => (row[r] ? row[m] / row[r] : 0))
  return (t) => basis(t).reduce((s, b, k) => s + b * coef[k], 0)
}

/**
 * A finish line runs round the stump as a smooth wave. Where the loop dives
 * off it for a stretch (onto the die's ditch, the socket edge or a
 * neighbour's contact — the DP follows a gradual slide), re-pick the
 * candidate that lies on the wave, or leave the sample to be filled from its
 * neighbours. The wave: an order-2 Fourier fit (order 3 follows a 90° dive, order 1 cuts real scallops) of height and radius, robust
 * (re-weighted) so the dive itself doesn't pull it.
 */
const ORDER = 2
function rejectDives(cands: Candidate[][], picks: number[], missing: boolean[], thetas: number[]): void {
  const K = picks.length
  const idx = picks.map((j, k) => (missing[k] ? -1 : j))
  const ok = idx.map((j) => j >= 0)
  if (ok.filter(Boolean).length < K * 0.5) return
  const h = idx.map((j, k) => (j >= 0 ? cands[k][j].h : 0))
  const r = idx.map((j, k) => (j >= 0 ? cands[k][j].r : 0))
  let w: number[] = ok.map((x) => (x ? 1 : 0))
  let fh = fourierFit(thetas, h, w, ORDER)
  let fr = fourierFit(thetas, r, w, ORDER)
  for (let it = 0; it < 4; it++) {
    // Tukey weights on the combined residual, scale 1 mm.
    w = thetas.map((t, k) => {
      if (!ok[k]) return 0
      const e = Math.hypot(h[k] - fh(t), 0.5 * (r[k] - fr(t)))
      return e < 1 ? (1 - e * e) ** 2 : 0
    })
    fh = fourierFit(thetas, h, w, ORDER)
    fr = fourierFit(thetas, r, w, ORDER)
  }
  for (let k = 0; k < K; k++) {
    if (!ok[k]) continue
    const res = (c: Candidate): number => Math.hypot(c.h - fh(thetas[k]), 0.5 * (c.r - fr(thetas[k])))
    if (res(cands[k][idx[k]]) <= 0.8) continue
    let best = -1
    for (let j = 0; j < cands[k].length; j++) if (res(cands[k][j]) < 0.5 && (best < 0 || res(cands[k][j]) < res(cands[k][best]))) best = j
    if (best >= 0) picks[k] = best
    else missing[k] = true
  }
}

function detectOnce(
  scan: SurfaceIndex,
  centre: Vec3,
  up: Vec3,
  K: number,
  radius: number,
  minTurn = 0.45,
  creases = false
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
    const list = prof ? profileCandidates(prof, topH, minTurn, creases) : []
    cands.push(list.map((c) => ({ ...c, point: profileToWorld(frame, th, { r: c.r, h: c.h }) })))
  }
  const typicalR = median(cands.flatMap((c) => c.slice(0, 1).map((x) => x.r))) || 4
  const { picks, missing } = chooseLoop(cands, (2 * Math.PI * typicalR) / K)
  rejectDives(cands, picks, missing, thetas)
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
  // In the low-threshold (feather-edge) pass every sample is a guess carried
  // by continuity, so confidence is capped below the "trust it" line.
  // A crease is the visible end of the prep, not necessarily the finish
  // line (it may sit under the gum): capped below the trust line as well.
  const conf = scores.map((s) => clamp(s / 1.6, 0, minTurn < 0.45 || creases ? 0.34 : 1))
  return { ok: true, result: { points: snapped, thetas, axis: frame, confidence: conf, top, missingFraction: missingCount / K } }
}

/** Full margin detection from a single tap on the prep. */
export function detectMargin(scan: SurfaceIndex, tap: Vec3, opts: MarginOptions = {}): MarginResult {
  const first = detectWith(scan, tap, opts, false)
  const mean = (c: number[]): number => (c.length ? c.reduce((a, b) => a + b, 0) / c.length : 0)
  if (first.points.length && mean(first.confidence) >= 0.35) return first
  // Weak or no finish line: the scan may have been taken without retraction,
  // with the gum hugging the prep. Read the wall–gum crease instead, if that
  // makes a margin-shaped loop (flagged for review either way).
  const crease = detectWith(scan, tap, opts, true)
  const useCrease = crease.points.length && plausibleLoop(crease) && !(first.points.length && plausibleLoop(first) && mean(first.confidence) >= mean(crease.confidence))
  return useCrease ? { ...crease, gumLine: true } : first
}

function detectWith(scan: SurfaceIndex, tap: Vec3, opts: MarginOptions, creases: boolean): MarginResult {
  const K = opts.samples ?? 180
  const radius = opts.radius ?? 8
  let up = opts.up ? normalize(opts.up) : estimateUp(scan, tap)
  let centre = centreAxis(scan, tap, up)
  // Chamfers and shoulders turn sharply at the finish line; a feather edge
  // barely turns (≈ 5–10°). If the sharp-corner pass can't close a loop,
  // retry accepting shallow corners and let continuity carry it.
  let minTurn = 0.45
  let { result, ok } = detectOnce(scan, centre, up, K, radius, minTurn, creases)
  if (!ok) {
    const retry = detectOnce(scan, centre, up, K, radius, 0.06, creases)
    // A shallow-corner loop is only kept if it looks like a margin: a smooth
    // ring around the stump, not a path wandering onto gingiva or neighbours.
    if (retry.ok && plausibleLoop(retry.result)) {
      minTurn = 0.06
      result = retry.result
      ok = true
    }
  }
  if (!ok) return { ...result, points: [] }
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
    const again = detectOnce(scan, centre, up, K, radius, minTurn, creases)
    if (!again.ok) break
    result = again.result
  }
  return result
}

/** Ring-shaped, smooth, and below the prep top: what any margin looks like. */
export function plausibleLoop(m: MarginResult): boolean {
  const pts = m.points
  if (pts.length < 16) return false
  const c = pca3(pts).mean
  const up = m.axis.up
  const rs = pts.map((p) => {
    const d = sub(p, c)
    const h = dot(d, up)
    return Math.hypot(d[0] - up[0] * h, d[1] - up[1] * h, d[2] - up[2] * h)
  })
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length
  const sd = Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / rs.length)
  let jumps = 0
  for (let i = 0; i < pts.length; i++) if (dist(pts[i], pts[(i + 1) % pts.length]) > Math.max(0.6, (4 * Math.PI * mean) / pts.length)) jumps++
  const hs = pts.map((p) => dot(sub(p, m.top), up))
  return mean > 2 && mean < 7.5 && sd / mean < 0.22 && jumps <= pts.length * 0.02 && Math.max(...hs) < -0.5
}

/**
 * Margin from points the technician tapped around the prep (any order):
 * ordered by angle about their centroid, joined with a closed spline,
 * resampled and snapped onto the scan. For finish lines the detector
 * can't see (feather-edge / vertical preps, heavily subgingival margins).
 */
export function marginFromTaps(scan: SurfaceIndex, taps: Vec3[], K = 180): MarginResult {
  if (taps.length < 4) throw new Error('Tap at least 4 points around the margin.')
  const fit = pca3(taps)
  let up = fit.axes[0]
  // The prep top is a short ray away along +up; the root side is not.
  const ahead = scan.raycast(fit.mean, up, 0, 20)
  const behind = scan.raycast(fit.mean, scale(up, -1), 0, 20)
  if ((behind?.distance ?? Infinity) < (ahead?.distance ?? Infinity)) up = scale(up, -1)
  const frame = axisFrame(fit.mean, up)
  const side = cross(up, frame.ref)
  const ordered = [...taps]
    .map((p) => {
      const d = sub(p, fit.mean)
      return { p, a: Math.atan2(dot(d, side), dot(d, frame.ref)) }
    })
    .sort((x, y) => x.a - y.a)
    .map((x) => x.p)
  // Closed Catmull–Rom through the taps, then snapped to the surface.
  const n = ordered.length
  const dense: Vec3[] = []
  const per = Math.ceil((K * 2) / n)
  for (let i = 0; i < n; i++) {
    const p0 = ordered[(i - 1 + n) % n]
    const p1 = ordered[i]
    const p2 = ordered[(i + 1) % n]
    const p3 = ordered[(i + 2) % n]
    for (let k = 0; k < per; k++) {
      const t = k / per
      const t2 = t * t
      const t3 = t2 * t
      const q: Vec3 = [0, 0, 0]
      for (let a = 0; a < 3; a++) {
        q[a] = 0.5 * (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3)
      }
      dense.push(q)
    }
  }
  // Resample to K points evenly by arc length.
  const cum = [0]
  for (let i = 1; i <= dense.length; i++) cum.push(cum[i - 1] + dist(dense[i - 1], dense[i % dense.length]))
  const total = cum[cum.length - 1]
  const points: Vec3[] = []
  let j = 0
  for (let k = 0; k < K; k++) {
    const target = (total * k) / K
    while (j < dense.length - 1 && cum[j + 1] < target) j++
    const a = dense[j]
    const b = dense[(j + 1) % dense.length]
    const t = (target - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j])
    const q: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
    points.push(scan.closest(q, 2)?.point ?? q)
  }
  const topHit = scan.raycast(add(fit.mean, scale(up, 15)), scale(up, -1), 0, 30)
  return {
    points,
    thetas: points.map((_, k) => (2 * Math.PI * k) / K),
    axis: axisFrame(fit.mean, up),
    confidence: points.map(() => 1),
    top: topHit ? topHit.point : add(fit.mean, scale(up, 4)),
    missingFraction: 0
  }
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
