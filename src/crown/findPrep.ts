import { SurfaceIndex, add, cross, dot, normalize, pca3, scale, sub, type Vec3 } from './geom'

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

export function findPrep(prep: SurfaceIndex, antagonist: SurfaceIndex | null): PrepGuess {
  if (!antagonist) return { point: null, reason: 'No opposing scan — tap the prepared tooth.', blobsMm2: [] }

  // 1. Occlusal plane from the contacts.
  const samples = samplePositions(prep, 30000)
  const near = samples.map((p) => antagonist.closest(p, MAX_GAP + CONTACT)?.distance ?? Infinity)
  const gap = Math.min(...near)
  const contacts = samples.filter((_, k) => near[k] <= gap + CONTACT)
  if (gap > MAX_GAP || contacts.length < 40) return { point: null, reason: 'The arches don’t touch, so they aren’t in the bite — tap the prepared tooth.', blobsMm2: [] }
  // The occlusal direction: of the principal axes of the contacts and of
  // both scans, the one along which the prep's top surface sees the
  // antagonist best. (A contact plane alone is unreliable when contacts are
  // few or lie along a line.)
  const antSamples = samplePositions(antagonist, 5000)
  const antMid = pca3(antSamples).mean
  const plane = pca3(contacts)
  const axes = [...plane.axes, ...pca3(samples).axes, ...pca3(antSamples).axes].map((a) => (dot(sub(antMid, plane.mean), a) < 0 ? scale(a, -1) : a))
  let n = axes[0]
  let bestScore = -1
  for (const c of axes) {
    const sc = coverage(prep, antagonist, samples, plane.mean, normalize(c), gap)
    if (sc > bestScore) {
      bestScore = sc
      n = normalize(c)
    }
  }
  const u = normalize(cross(Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], n))
  const v = cross(n, u)

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
  const candidates = blobs.filter((b) => area(b) >= MIN_BLOB_MM2).map((b) => ({ point: middle(b), areaMm2: area(b) }))
  const best = blobs[0]
  if (!best || area(best) < MIN_BLOB_MM2) return { point: null, reason: 'No prepared tooth stands out from the bite — tap it.', blobsMm2, candidates }
  if (blobs[1] && area(blobs[1]) > 0.6 * area(best)) return { point: null, reason: 'More than one tooth is out of contact — tap the one to restore.', blobsMm2, candidates }
  return { point: candidates[0].point, blobsMm2, candidates }
}
