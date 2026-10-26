import { SurfaceIndex, add, cross, dot, normalize, pca3, scale, sub, type Vec3 } from './geom'
import { detectMargin, plausibleLoop, type MarginResult } from './margin'

/**
 * Finds the prepared tooth without a tap, the way a technician spots it:
 * natural teeth touch the opposing arch, the prep doesn't. Occlusal
 * reduction leaves the whole stump top 0.6–4 mm short of the antagonist,
 * while cusps of natural teeth are in contact and gingiva / gaps sit
 * further away.
 *
 * 1. Contacts between the arches give the occlusal plane and, with the
 *    antagonist's side, the occlusal direction. Bite registrations often
 *    leave the arches a few tenths apart, so "contact" means within 0.4 mm
 *    of their closest approach, and clearances are measured from it.
 * 2. A 0.5 mm grid over that plane: drop a ray onto the prep scan (the top
 *    surface seen from the antagonist), then measure the clearance up to
 *    the antagonist.
 * 3. Cells with prep-like clearance, eroded by 2 mm so the scattered gaps
 *    between natural cusps vanish; the largest remaining blob is the prep.
 *
 * Needs both arches, in occlusion. Returns why it failed otherwise, so the
 * app can fall back to asking for a tap.
 */

export interface PrepGuess {
  point: Vec3 | null
  /** Plain-language reason when `point` is null. */
  reason?: string
  /** Eroded blob areas found, mm², largest first (diagnostics). */
  blobsMm2: number[]
  /** Every out-of-contact blob, largest first: its middle on the scan and its area. */
  candidates?: Array<{ point: Vec3; areaMm2: number }>
  /** Occlusal directions to try in the margin search: the bite plane's normal, then the direction between the arches. */
  ups?: Vec3[]
}

const CELL = 0.5
const CONTACT = 0.4 // band above the closest approach that counts as "in contact"
const MAX_GAP = 1.0 // closest approach allowed for scans exported "in occlusion"
const MIN_CLEAR = 0.6
const MAX_CLEAR = 4.0
const ERODE_MM = 2.0
const MIN_BLOB_MM2 = 2.0

function samplePositions(index: SurfaceIndex, max: number): Vec3[] {
  const pos = index.geometry.getAttribute('position')
  const stride = Math.max(1, Math.floor(pos.count / max))
  const out: Vec3[] = []
  for (let i = 0; i < pos.count; i += stride) out.push([pos.getX(i), pos.getY(i), pos.getZ(i)])
  return out
}

/** How many 1 mm columns over the prep see the antagonist close above them, looking along n. */
function coverage(prep: SurfaceIndex, ant: SurfaceIndex, samples: Vec3[], origin: Vec3, n: Vec3, gap: number): number {
  const u = normalize(cross(Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], n))
  const v = cross(n, u)
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity, hmax = -Infinity
  for (let k = 0; k < samples.length; k += 7) {
    const d = sub(samples[k], origin)
    const a = dot(d, u), b = dot(d, v), h = dot(d, n)
    umin = Math.min(umin, a); umax = Math.max(umax, a); vmin = Math.min(vmin, b); vmax = Math.max(vmax, b); hmax = Math.max(hmax, h)
  }
  const step = Math.max(1, Math.sqrt(((umax - umin) * (vmax - vmin)) / 2500))
  const down = scale(n, -1)
  let seen = 0
  for (let a = umin; a <= umax; a += step) {
    for (let b = vmin; b <= vmax; b += step) {
      const hit = prep.raycast(add(origin, add(add(scale(u, a), scale(v, b)), scale(n, hmax + 2))), down)
      if (!hit) continue
      const up = ant.raycast(add(hit.point, scale(n, 0.01)), n, 0, gap + MAX_CLEAR + 1)
      if (up) seen++
    }
  }
  return seen
}

/**
 * `tooth` (Universal, from the order) ranks the candidates by where they sit
 * on the arch and picks one outright when the match is clear.
 */
export function findPrep(prep: SurfaceIndex, antagonist: SurfaceIndex | null, tooth?: number): PrepGuess {
  if (!antagonist) return { point: null, reason: 'No opposing scan — tap the prepared tooth.', blobsMm2: [] }

  // 1. Occlusal plane from the contacts.
  const samples = samplePositions(prep, 30000)
  const near = samples.map((p) => antagonist.closest(p, MAX_GAP + CONTACT)?.distance ?? Infinity)
  const gap = Math.min(...near)
  const contacts = samples.filter((_, k) => near[k] <= gap + CONTACT)
  if (gap > MAX_GAP || contacts.length < 40) return { point: null, reason: 'The arches don’t touch, so they aren’t in the bite — tap the prepared tooth.', blobsMm2: [] }
  // The occlusal direction: the normal of the plane the contacts span — or,
  // when they lie along a line, the best-covering principal axis (below).
  const antSamples = samplePositions(antagonist, 5000)
  const antMid = pca3(antSamples).mean
  // pca3 sorts axes by variance, smallest first: axes[0] is the plane normal.
  const plane = pca3(contacts)
  const toward = (a: Vec3): Vec3 => normalize(dot(sub(antMid, plane.mean), a) < 0 ? scale(a, -1) : a)
  const sd = plane.values.map((v) => Math.sqrt(Math.max(0, v)))
  let n = toward(plane.axes[0])
  if (!(sd[1] >= 3 && sd[0] < 0.5 * sd[1])) {
    // Contacts along a line (one short segment of arch) don't fix a plane:
    // take the candidate axis along which the prep's top sees the antagonist best.
    let bestScore = -1
    for (const c of [...plane.axes, ...pca3(samples).axes, ...pca3(antSamples).axes].map(toward)) {
      const sc = coverage(prep, antagonist, samples, plane.mean, c, gap)
      if (sc > bestScore) {
        bestScore = sc
        n = c
      }
    }
  }
  const u = normalize(cross(Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], n))
  const v = cross(n, u)
  const ups: Vec3[] = [n, normalize(sub(antMid, pca3(samples).mean))]

  // 2. Clearance grid over the prep scan's footprint.
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity, hmax = -Infinity
  for (const p of samples) {
    const d = sub(p, plane.mean)
    const a = dot(d, u), b = dot(d, v), h = dot(d, n)
    if (a < umin) umin = a
    if (a > umax) umax = a
    if (b < vmin) vmin = b
    if (b > vmax) vmax = b
    if (h > hmax) hmax = h
  }
  const nu = Math.ceil((umax - umin) / CELL) + 1
  const nv = Math.ceil((vmax - vmin) / CELL) + 1
  if (nu * nv > 400 * 400) return { point: null, reason: 'The scan is too large to search — tap the prepared tooth.', blobsMm2: [] }
  const down = scale(n, -1)
  const ok = new Uint8Array(nu * nv)
  const top: Array<Vec3 | null> = new Array(nu * nv).fill(null)
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const k = i * nv + j
      const start = add(plane.mean, add(add(scale(u, umin + i * CELL), scale(v, vmin + j * CELL)), scale(n, hmax + 2)))
      const hit = prep.raycast(start, down)
      if (!hit) continue
      top[k] = hit.point
      const up = antagonist.raycast(add(hit.point, scale(n, 0.01)), n, 0, MAX_CLEAR + gap + 1)
      const clear = up ? up.distance - gap : Infinity
      if (clear >= MIN_CLEAR && clear <= MAX_CLEAR) ok[k] = 1
    }
  }

  // 3. Erode (disc of ERODE_MM), then connected blobs.
  const r = Math.round(ERODE_MM / CELL)
  const offsets: Array<[number, number]> = []
  for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) if (di * di + dj * dj <= r * r) offsets.push([di, dj])
  const core = new Uint8Array(nu * nv)
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      if (!ok[i * nv + j]) continue
      let all = true
      for (const [di, dj] of offsets) {
        const a = i + di, b = j + dj
        if (a < 0 || b < 0 || a >= nu || b >= nv || !ok[a * nv + b]) {
          all = false
          break
        }
      }
      if (all) core[i * nv + j] = 1
    }
  }
  const label = new Int32Array(nu * nv).fill(-1)
  const blobs: Array<{ cells: number[] }> = []
  for (let s = 0; s < nu * nv; s++) {
    if (!core[s] || label[s] >= 0) continue
    const cells: number[] = []
    const stack = [s]
    label[s] = blobs.length
    while (stack.length) {
      const c = stack.pop()!
      cells.push(c)
      const ci = Math.floor(c / nv), cj = c % nv
      for (const [a, b] of [[ci + 1, cj], [ci - 1, cj], [ci, cj + 1], [ci, cj - 1]]) {
        if (a < 0 || b < 0 || a >= nu || b >= nv) continue
        const q = a * nv + b
        if (core[q] && label[q] < 0) {
          label[q] = blobs.length
          stack.push(q)
        }
      }
    }
    blobs.push({ cells })
  }
  const area = (b: { cells: number[] }): number => b.cells.length * CELL * CELL
  blobs.sort((a, b) => b.cells.length - a.cells.length)
  const blobsMm2 = blobs.map(area)
  // Each blob's middle, on the scan.
  const middle = (b: { cells: number[] }): Vec3 => {
    let ci = 0, cj = 0
    for (const c of b.cells) {
      ci += Math.floor(c / nv)
      cj += c % nv
    }
    ci /= b.cells.length
    cj /= b.cells.length
    let pick = b.cells[0]
    let bd = Infinity
    for (const c of b.cells) {
      const d = (Math.floor(c / nv) - ci) ** 2 + ((c % nv) - cj) ** 2
      if (d < bd) {
        bd = d
        pick = c
      }
    }
    return top[pick]!
  }
  let candidates = blobs.filter((b) => area(b) >= MIN_BLOB_MM2).map((b) => ({ point: middle(b), areaMm2: area(b) }))
  if (tooth && candidates.length) {
    // Tooth-level surface (crowns, not palate or gingiva): within 7 mm of the bite.
    const toothLevel: Vec3[] = []
    let hTop = -Infinity
    for (const p of top) if (p) hTop = Math.max(hTop, dot(p, n))
    for (const p of top) if (p && dot(p, n) > hTop - 7) toothLevel.push(p)
    const r = rankByTooth(candidates, toothLevel, n, tooth)
    candidates = r.ranked.map(({ point, areaMm2 }) => ({ point, areaMm2 }))
    if (r.confident) return { point: candidates[0].point, blobsMm2, candidates, ups }
    if (r.ranked[0].offDeg <= 20) return { point: null, reason: `More than one tooth near #${tooth} is out of contact — tap the one to restore.`, blobsMm2, candidates, ups }
  }
  const best = blobs[0]
  if (!best || area(best) < MIN_BLOB_MM2) return { point: null, reason: 'No prepared tooth stands out from the bite — tap it.', blobsMm2, candidates, ups }
  if (blobs[1] && area(blobs[1]) > 0.6 * area(best)) return { point: null, reason: 'More than one tooth is out of contact — tap the one to restore.', blobsMm2, candidates, ups }
  return { point: candidates[0].point, blobsMm2, candidates, ups }
}

/**
 * The highest scan point (along `up`) within `radiusMm` of a point: moves a
 * tap or pin that landed on the side of a stump to its top, where the
 * margin search starts best.
 */
export function stumpTop(index: SurfaceIndex, near: Vec3, up: Vec3, radiusMm = 4): Vec3 {
  const pos = index.geometry.getAttribute('position')
  const n = normalize(up)
  let best = near
  let bestH = dot(near, n)
  const r2 = radiusMm * radiusMm
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) - near[0]
    const y = pos.getY(i) - near[1]
    const z = pos.getZ(i) - near[2]
    if (x * x + y * y + z * z > r2) continue
    const p: Vec3 = [pos.getX(i), pos.getY(i), pos.getZ(i)]
    const h = dot(p, n)
    if (h > bestH) {
      bestH = h
      best = p
    }
  }
  return best
}

/**
 * Margin search from several occlusal directions — the bite plane's normal,
 * the direction between the arches, and the scan's own estimate — keeping
 * the loop that reads best: closed, plausible, most confident. One direction
 * is rarely right for every tooth on a real arch.
 */
export function bestMargin(index: SurfaceIndex, tap: Vec3, ups: Vec3[]): MarginResult {
  const tries: MarginResult[] = [detectMargin(index, tap)]
  for (const up of ups) tries.push(detectMargin(index, stumpTop(index, tap, up), { up }))
  const score = (m: MarginResult): number => {
    if (m.points.length < 16) return -1
    const conf = m.confidence.reduce((a, b) => a + b, 0) / m.confidence.length
    return conf + (plausibleLoop(m) ? 0.2 : 0) - 0.5 * m.missingFraction
  }
  return tries.reduce((a, b) => (score(b) > score(a) ? b : a))
}

/**
 * Where a point sits on the arch, read from the arch itself: the two ends of
 * the dentition (farthest pair of tooth-level points) give left–right, the
 * point farthest in front of their midpoint gives anterior. Returns the side
 * (patient's 'left' | 'right') and the angle from the midline (0° incisors,
 * ~90° last molars).
 */
export function archPosition(toothLevel: Vec3[], up: Vec3, upper: boolean, p: Vec3): { side: 'left' | 'right'; angleDeg: number } | null {
  if (toothLevel.length < 50) return null
  const n = normalize(up)
  const flat = (q: Vec3): Vec3 => sub(q, scale(n, dot(q, n)))
  const pts = toothLevel.map(flat)
  // Farthest pair (approximate: farthest from the centroid, then farthest from that).
  const c = pts.reduce((a, q) => add(a, scale(q, 1 / pts.length)), [0, 0, 0] as Vec3)
  const far = (from: Vec3): Vec3 => pts.reduce((b, q) => (dist2(q, from) > dist2(b, from) ? q : b), pts[0])
  const e1 = far(c)
  const e2 = far(e1)
  const mid = scale(add(e1, e2), 0.5)
  const lr = normalize(sub(e2, e1))
  // Anterior: the tooth-level point farthest from the line through the ends.
  const apex = pts.reduce((b, q) => {
    const off = (x: Vec3): number => Math.abs(dot(sub(x, mid), normalize(cross(n, lr))))
    return off(q) > off(b) ? q : b
  }, pts[0])
  const ant = normalize(sub(apex, mid))
  // Patient's left = superior × anterior; n points to the antagonist (down for an upper arch).
  const superior = upper ? scale(n, -1) : n
  const left = normalize(cross(superior, ant))
  const d = sub(flat(p), mid)
  const x = dot(d, left)
  const y = dot(d, ant)
  return { side: x >= 0 ? 'left' : 'right', angleDeg: (Math.atan2(Math.abs(x), y) * 180) / Math.PI }
}

const dist2 = (a: Vec3, b: Vec3): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

/** Expected angle from the midline for a position 1 (central) … 8 (third molar). */
const POSITION_DEG = [8, 22, 35, 48, 58, 68, 78, 86]

/** Universal number → side and position from the midline. */
export function toothSide(universal: number): { upper: boolean; side: 'left' | 'right'; pos: number } {
  if (universal <= 16) return universal <= 8 ? { upper: true, side: 'right', pos: 9 - universal } : { upper: true, side: 'left', pos: universal - 8 }
  return universal <= 24 ? { upper: false, side: 'left', pos: 25 - universal } : { upper: false, side: 'right', pos: universal - 24 }
}

/**
 * Orders prep candidates by how well their arch position matches the tooth
 * on the order; `confident` when the best is on the right side, within 20°,
 * and clearly ahead of the next.
 */
export function rankByTooth(candidates: Array<{ point: Vec3; areaMm2: number }>, toothLevel: Vec3[], up: Vec3, tooth: number): { ranked: Array<{ point: Vec3; areaMm2: number; offDeg: number }>; confident: boolean } {
  const t = toothSide(tooth)
  const want = POSITION_DEG[t.pos - 1]
  const scored = candidates.map((c) => {
    const at = archPosition(toothLevel, up, t.upper, c.point)
    const offDeg = !at ? 999 : (at.side === t.side ? 0 : 100) + Math.abs(at.angleDeg - want)
    return { ...c, offDeg }
  })
  scored.sort((a, b) => a.offDeg - b.offDeg)
  const confident = scored.length > 0 && scored[0].offDeg <= 20 && (scored.length === 1 || scored[1].offDeg - scored[0].offDeg >= 15)
  return { ranked: scored, confident }
}
