// gates.mjs — the spec §6 validation suite as CALLABLE gates G1–G7 over parts
// shaped {name, manifold, printOrientation, meta} (api.md module contract).
//   G1 manifold + STL round-trip (re-read the written bytes, re-manifold,
//      volume ±0.1 %)                                  — §6-G1
//   G2 min-wall by normal-ray sampling (~2000 surface points; ≥2.0 hull,
//      ≥3.0 in declared boss regions)                  — §6-G2
//   G3 sealed-cavity genus rule + the every-dome-has-a-hole drainability
//      check in the DECLARED print orientation         — §6-G3
//   G4 plate fit in the declared orientation incl. 5–6 mm support standoff
//                                                      — §6-G4
//   G5 the J1–J6 clearance walker over machine.mjs FIT — §6-G5
//   G6 buoyancy/stability (delegates to hydroPlus)     — §6-G6
//   G7 mass manifest → parts/manifest.json             — §6-G7
// Every clearance/plate/density/wall number is IMPORTED from machine.mjs;
// the few remaining literals are spec §2/§4/§6 values kept in exported
// tables (GATE, JOINTS) so nothing hides inside function bodies.
import { boot, writeSTL, M } from '../lib.mjs'
import { FIT, PLATE, RHO, WALL, ENVELOPE, MASS } from './machine.mjs'
import { gzSweep, hydrostatics, ellipsoidAnalytic } from './hydroPlus.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const wasm = await boot() // idempotent — lib.mjs caches the WASM module

export const GATE = {
  standoffMm: 6, // D2/G4: pods sit on a 5–6 mm break-away standoff — budget the worst case
  designBandFrac: [0.40, 0.60], // §3: acceptable draft-fraction band
  maxChamberCm3: 115, // §6-G6: max single sealed chamber (worst flood still floats)
  volTolFrac: 0.001, // G1: round-trip volume ±0.1 %
  minWallSamples: 30000, // G2 sample budget — 2000 demonstrably missed a real 1.88 mm nose wall and a 0.22 mm crest chord (audit G: both surfaced only at 30k+)
  minExitDot: 0.5, // G2: exit face within 60° of the ray = a wall pair (else grazing an edge/aperture — reported, not thickness)
  wallTolMm: 0.05, // G2 sampling tolerance under the class floor
  maxProbeMm: 12, // G2: rays longer than this are "thick enough"
  colPitchMm: 0.8, // G3 drainability column pitch (catches Ø2 vents: grid point guaranteed inside)
  poolTolMm: 1.0, // G3: tolerated resin pooling depth above a cavity floor
  maxTrappedMm3: 50, // G3: trapped + pooled resin ceiling per part (≈ one Ø4.5 sphere)
  g5MeasureTolMm: 0.02 // G5: modeled-vs-specced gap tolerance
}

/** J1–J6 baseline clearance table (spec §4). Values that machine.mjs owns are
 *  imported; the J5/J6 diameters are §4 literals (drain plug Ø3.9 in Ø4.0,
 *  retainer cap Ø6.1 blind bore on the Ø6.0 pin). */
export const JOINTS = [
  { joint: 'J1', name: 'hull-seam registration pins Ø3.0→Ø3.3', perSideMm: FIT.pinSocketRadial, kind: 'radial' },
  { joint: 'J1', name: 'bondline standoff nubs (glue gap)', perSideMm: FIT.bondlineNub, kind: 'axial', note: 'bond thickness control, not a running fit' },
  { joint: 'J2', name: 'tail hinge Ø6.0 pin → Ø6.5 bores', perSideMm: FIT.hingeRadial, kind: 'radial' },
  { joint: 'J3', name: 'M20×2.5 ballast port, female offset', perSideMm: FIT.threadFemaleRadial, kind: 'radial' },
  { joint: 'J4', name: 'fin tang Ø6.0 → Ø6.3 socket', perSideMm: FIT.finTangRadial, kind: 'radial' },
  { joint: 'J5', name: 'drain plug Ø3.9 (2° taper) in Ø4.0', perSideMm: +((4.0 - 3.9) / 2).toFixed(3), kind: 'radial', note: 'at the testable floor by design — tapered + UV-resin bedded, not a running fit (spec §4 J5)' },
  { joint: 'J6', name: 'retainer cap Ø6.1 blind bore on Ø6.0 pin', perSideMm: +((6.1 - 6.0) / 2).toFixed(3), kind: 'radial', note: 'snug by design; silicone-dabbed, serviceable (spec §4 J6)' }
]

// ── shared helpers ────────────────────────────────────────────────────────
function statusOf(m) {
  const s = m.status()
  return String(s?.value ?? s)
}
const statusOk = (s) => s === '0' || s === 'NoError'

function meshArrays(manifold) {
  const mesh = manifold.getMesh()
  return { P: mesh.vertProperties, np: mesh.numProp, T: mesh.triVerts, nTri: mesh.triVerts.length / 3 }
}

/** deterministic RNG (mulberry32) so gate runs are reproducible */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** orthonormal print frame {u,v,w} with w = declared up direction */
export function frameFromUp(up = [0, 0, 1]) {
  const n = Math.hypot(up[0], up[1], up[2]) || 1
  const w = [up[0] / n, up[1] / n, up[2] / n]
  const ref = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  let u = [ref[1] * w[2] - ref[2] * w[1], ref[2] * w[0] - ref[0] * w[2], ref[0] * w[1] - ref[1] * w[0]]
  const un = Math.hypot(...u)
  u = [u[0] / un, u[1] / un, u[2] / un]
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]]
  return { u, v, w }
}

// ── G1 · manifold + STL round-trip ────────────────────────────────────────
export function G1_manifoldRoundtrip(part, { dir = new URL('../parts/', import.meta.url).pathname, label } = {}) {
  const m = part.manifold
  const status = statusOf(m)
  const vol = m.volume()
  const pre = statusOk(status) && !m.isEmpty() && vol > 0
  mkdirSync(dir, { recursive: true })
  const stlPath = dir + part.name + '.stl'
  const stl = writeSTL(m, stlPath, label ?? `saycad fish ${part.name}`)
  const bytesOk = stl.bytes === 84 + 50 * stl.triangles

  // re-read the WRITTEN BYTES, re-manifold, compare volume ±0.1 %
  const buf = readFileSync(stlPath)
  const tri = buf.readUInt32LE(80)
  const verts = new Float32Array(tri * 9)
  const tris = new Uint32Array(tri * 3)
  for (let t = 0; t < tri; t++) {
    const off = 84 + t * 50 + 12 // skip the normal
    for (let k = 0; k < 9; k++) verts[t * 9 + k] = buf.readFloatLE(off + k * 4)
    tris[t * 3] = t * 3; tris[t * 3 + 1] = t * 3 + 1; tris[t * 3 + 2] = t * 3 + 2
  }
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: verts, triVerts: tris })
  const merged = mesh.merge()
  const rt = new wasm.Manifold(mesh)
  const rtStatus = statusOf(rt)
  const rtVol = statusOk(rtStatus) ? rt.volume() : NaN
  rt.delete()
  const volMatch = Math.abs(rtVol - vol) / vol < GATE.volTolFrac
  const ok = pre && bytesOk && tri === stl.triangles && merged && statusOk(rtStatus) && volMatch
  return {
    gate: 'G1', name: part.name, ok,
    status, volumeCm3: +(vol / 1000).toFixed(2), stlPath, triangles: stl.triangles, bytes: stl.bytes,
    roundTrip: { merged, status: rtStatus, volCm3: +(rtVol / 1000).toFixed(2), volMatchPct: +((rtVol - vol) / vol * 100).toFixed(4) }
  }
}
// ── G2 · min-wall by normal-ray sampling ──────────────────────────────────
/** Sample ~`samples` points on the surface (area-weighted), fire a ray along
 *  the inward normal, and take the first hit whose exit face is within 60° of
 *  the ray (a wall pair). Grazing hits (aperture rims, perpendicular corners)
 *  are counted separately, not as wall thickness. Thresholds: meta.minWallMm
 *  (default WALL.hullFloor = 2.0); samples inside meta.bossRegions AABBs use
 *  WALL.boss = 3.0; meta.excludeRegions AABBs are skipped (declared thin
 *  features, e.g. break-away skirt webs). */
export function G2_minWall(part, {
  samples = GATE.minWallSamples,
  minWallMm = part.meta?.minWallMm ?? WALL.hullFloor,
  bossMinMm = WALL.boss,
  bossRegions = part.meta?.bossRegions ?? [],
  excludeRegions = part.meta?.excludeRegions ?? [],
  maxProbeMm = GATE.maxProbeMm,
  seed = 20260818
} = {}) {
  const { P, np, T, nTri } = meshArrays(part.manifold)
  // triangle data
  const A = new Float64Array(nTri) // areas
  const N = new Float64Array(nTri * 3) // unit normals
  const V = new Float64Array(nTri * 9) // verts copied flat
  let totalArea = 0
  for (let t = 0; t < nTri; t++) {
    for (let j = 0; j < 3; j++) {
      const b = T[3 * t + j] * np
      V[9 * t + 3 * j] = P[b]; V[9 * t + 3 * j + 1] = P[b + 1]; V[9 * t + 3 * j + 2] = P[b + 2]
    }
    const o = 9 * t
    const ux = V[o + 3] - V[o], uy = V[o + 4] - V[o + 1], uz = V[o + 5] - V[o + 2]
    const wx = V[o + 6] - V[o], wy = V[o + 7] - V[o + 1], wz = V[o + 8] - V[o + 2]
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    const len = Math.hypot(nx, ny, nz)
    A[t] = len / 2
    totalArea += A[t]
    if (len > 0) { N[3 * t] = nx / len; N[3 * t + 1] = ny / len; N[3 * t + 2] = nz / len }
  }
  const cum = new Float64Array(nTri)
  let acc = 0
  for (let t = 0; t < nTri; t++) { acc += A[t]; cum[t] = acc }

  // uniform grid over the AABB for segment queries
  const bb = part.manifold.boundingBox()
  const dims = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]]
  const cell = Math.max(3, Math.max(...dims) / 64)
  const nc = dims.map((d) => Math.max(1, Math.ceil(d / cell + 1e-9)))
  const cellIdx = (i, j, k) => (i * nc[1] + j) * nc[2] + k
  const clampi = (x, n) => Math.min(n - 1, Math.max(0, x))
  const cellOf = (x, ax) => clampi(Math.floor((x - bb.min[ax]) / cell), nc[ax])
  // counting-sort triangle→cells
  const counts = new Uint32Array(nc[0] * nc[1] * nc[2] + 1)
  const triCellRange = (t) => {
    const o = 9 * t
    const lo = [0, 0, 0], hi = [0, 0, 0]
    for (let ax = 0; ax < 3; ax++) {
      const a1 = V[o + ax], a2 = V[o + 3 + ax], a3 = V[o + 6 + ax]
      lo[ax] = cellOf(Math.min(a1, a2, a3), ax)
      hi[ax] = cellOf(Math.max(a1, a2, a3), ax)
    }
    return { lo, hi }
  }
  for (let t = 0; t < nTri; t++) {
    const { lo, hi } = triCellRange(t)
    for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++)
      counts[cellIdx(i, j, k) + 1]++
  }
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1]
  const cellTris = new Uint32Array(counts[counts.length - 1])
  const fill = Uint32Array.from(counts.subarray(0, counts.length - 1))
  for (let t = 0; t < nTri; t++) {
    const { lo, hi } = triCellRange(t)
    for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++)
      cellTris[fill[cellIdx(i, j, k)]++] = t
  }
  const stamp = new Uint32Array(nTri)
  let qid = 0

  const rayHit = (ox, oy, oz, dx, dy, dz, skipTri, tMax) => {
    qid++
    let best = Infinity, bestTri = -1
    const ex = ox + dx * tMax, ey = oy + dy * tMax, ez = oz + dz * tMax
    const i0 = cellOf(Math.min(ox, ex), 0), i1 = cellOf(Math.max(ox, ex), 0)
    const j0 = cellOf(Math.min(oy, ey), 1), j1 = cellOf(Math.max(oy, ey), 1)
    const k0 = cellOf(Math.min(oz, ez), 2), k1 = cellOf(Math.max(oz, ez), 2)
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      const ci = cellIdx(i, j, k)
      for (let q = counts[ci]; q < counts[ci + 1]; q++) {
        const t = cellTris[q]
        if (stamp[t] === qid) continue
        stamp[t] = qid
        if (t === skipTri) continue
        // Möller–Trumbore, no culling
        const o = 9 * t
        const e1x = V[o + 3] - V[o], e1y = V[o + 4] - V[o + 1], e1z = V[o + 5] - V[o + 2]
        const e2x = V[o + 6] - V[o], e2y = V[o + 7] - V[o + 1], e2z = V[o + 8] - V[o + 2]
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
        const det = e1x * px + e1y * py + e1z * pz
        if (Math.abs(det) < 1e-12) continue
        const inv = 1 / det
        const tx = ox - V[o], ty = oy - V[o + 1], tz = oz - V[o + 2]
        const uu = (tx * px + ty * py + tz * pz) * inv
        if (uu < -1e-9 || uu > 1 + 1e-9) continue
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
        const vv = (dx * qx + dy * qy + dz * qz) * inv
        if (vv < -1e-9 || uu + vv > 1 + 1e-9) continue
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv
        if (tt > 5e-4 && tt < best && tt <= tMax) { best = tt; bestTri = t }
      }
    }
    return { t: best, tri: bestTri }
  }

  const inRegion = (p, regions) => regions.some((r) =>
    p[0] >= r.min[0] && p[0] <= r.max[0] && p[1] >= r.min[1] && p[1] <= r.max[1] && p[2] >= r.min[2] && p[2] <= r.max[2])

  const rand = rng(seed)
  const pickTri = () => {
    const x = rand() * totalArea
    let lo = 0, hi = nTri - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid }
    return lo
  }

  let minWall = Infinity, wallSamples = 0, grazing = 0, thick = 0, excluded = 0
  const wallVals = []
  const violations = []
  for (let s = 0; s < samples; s++) {
    const t = pickTri()
    if (A[t] <= 0) continue
    const r1 = rand(), r2 = rand()
    const su = 1 - Math.sqrt(r1), sv = Math.sqrt(r1) * (1 - r2), sw = 1 - su - sv
    const o = 9 * t
    const px = su * V[o] + sv * V[o + 3] + sw * V[o + 6]
    const py = su * V[o + 1] + sv * V[o + 4] + sw * V[o + 7]
    const pz = su * V[o + 2] + sv * V[o + 5] + sw * V[o + 8]
    if (inRegion([px, py, pz], excludeRegions)) { excluded++; continue }
    const dx = -N[3 * t], dy = -N[3 * t + 1], dz = -N[3 * t + 2]
    const hit = rayHit(px + dx * 1e-3, py + dy * 1e-3, pz + dz * 1e-3, dx, dy, dz, t, maxProbeMm)
    if (hit.tri < 0) { thick++; continue }
    const dot = N[3 * hit.tri] * dx + N[3 * hit.tri + 1] * dy + N[3 * hit.tri + 2] * dz
    if (dot < GATE.minExitDot) { grazing++; continue }
    const th = hit.t + 1e-3
    wallSamples++
    wallVals.push(th)
    if (th < minWall) minWall = th
    const req = inRegion([px, py, pz], bossRegions) ? bossMinMm : minWallMm
    if (th < req - GATE.wallTolMm && violations.length < 8) {
      violations.push({ atMm: [+px.toFixed(1), +py.toFixed(1), +pz.toFixed(1)], thicknessMm: +th.toFixed(3), requiredMm: req })
    } else if (th < req - GATE.wallTolMm) violations[7].more = (violations[7].more ?? 0) + 1
  }
  wallVals.sort((a, b) => a - b)
  const p01 = wallVals.length ? wallVals[Math.floor(wallVals.length * 0.01)] : null
  const nViol = violations.reduce((n, v) => n + 1 + (v.more ?? 0), 0)
  return {
    gate: 'G2', name: part.name, ok: nViol === 0 && wallSamples > 0,
    samples, wallSamples, grazing, thickBeyondProbe: thick, excluded,
    minWallSampledMm: minWall === Infinity ? null : +minWall.toFixed(3),
    p01Mm: p01 === null ? null : +p01.toFixed(3),
    requiredMm: { hull: minWallMm, boss: bossMinMm, tolMm: GATE.wallTolMm },
    violations: nViol, worst: violations
  }
}

// ── G3 · sealed-cavity rule + every-dome-has-a-hole (print orientation) ───
/** Drainability in the DECLARED print frame: air columns are cast on a
 *  colPitch grid; per column, solid intervals come from vertical ray parity;
 *  the air-segment graph is reverse-flooded from the plate plane with
 *  z-monotone (never-descending) moves — exactly "an opening at or below the
 *  cavity floor". Air a monotone path cannot reach is trapped: a print-sealed
 *  cavity (also caught by genus) or a dome/pocket without a low drain. */
export function drainability(manifold, up = [0, 0, 1], {
  colPitchMm = GATE.colPitchMm,
  poolTolMm = GATE.poolTolMm,
  maxTrappedMm3 = GATE.maxTrappedMm3
} = {}) {
  const { P, np, T, nTri } = meshArrays(manifold)
  const { u, v, w } = frameFromUp(up)
  const nVert = P.length / np
  const X = new Float64Array(nVert), Y = new Float64Array(nVert), Z = new Float64Array(nVert)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < nVert; i++) {
    const px = P[i * np], py = P[i * np + 1], pz = P[i * np + 2]
    const x = px * u[0] + py * u[1] + pz * u[2]
    const y = px * v[0] + py * v[1] + pz * v[2]
    const z = px * w[0] + py * w[1] + pz * w[2]
    X[i] = x; Y[i] = y; Z[i] = z
    if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x
    if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y
    if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z
  }
  const p = colPitchMm
  const ox = lo[0] - 2 * p, oy = lo[1] - 2 * p
  const nx = Math.ceil((hi[0] - lo[0] + 4 * p) / p), ny = Math.ceil((hi[1] - lo[1] + 4 * p) / p)
  const zBot = lo[2] - 2 * p, zTop = hi[2] + 2 * p

  // bin triangles per column cell by xy-AABB (inflated ±0.5 cell for jitter)
  const colTris = Array.from({ length: nx * ny }, () => [])
  for (let t = 0; t < nTri; t++) {
    const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2]
    const x0 = Math.min(X[a], X[b], X[c]) - 0.5 * p, x1 = Math.max(X[a], X[b], X[c]) + 0.5 * p
    const y0 = Math.min(Y[a], Y[b], Y[c]) - 0.5 * p, y1 = Math.max(Y[a], Y[b], Y[c]) + 0.5 * p
    const i0 = Math.max(0, Math.floor((x0 - ox) / p)), i1 = Math.min(nx - 1, Math.floor((x1 - ox) / p))
    const j0 = Math.max(0, Math.floor((y0 - oy) / p)), j1 = Math.min(ny - 1, Math.floor((y1 - oy) / p))
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) colTris[i * ny + j].push(t)
  }

  const jitters = [[0.5, 0.5], [0.5 + 0.171, 0.5 - 0.233], [0.5 - 0.267, 0.5 + 0.149]]
  const crossingsAt = (cx, cy, tris) => {
    const zs = []
    for (const t of tris) {
      const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2]
      const x1 = X[a], y1 = Y[a], x2 = X[b], y2 = Y[b], x3 = X[c], y3 = Y[c]
      const d = (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)
      if (Math.abs(d) < 1e-12) continue // vertical / degenerate in plan
      const l1 = ((y2 - y3) * (cx - x3) + (x3 - x2) * (cy - y3)) / d
      const l2 = ((y3 - y1) * (cx - x3) + (x1 - x3) * (cy - y3)) / d
      const l3 = 1 - l1 - l2
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue
      zs.push(l1 * Z[a] + l2 * Z[b] + l3 * Z[c])
    }
    zs.sort((q, r) => q - r)
    return zs
  }

  // build air segments per column: {lo, hi, entry}
  const segs = Array.from({ length: nx * ny }, () => null)
  let badColumns = 0
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const tris = colTris[i * ny + j]
    let zs = null
    for (const [jx, jy] of jitters) {
      const cx = ox + (i + jx) * p, cy = oy + (j + jy) * p
      const cand = tris.length ? crossingsAt(cx, cy, tris) : []
      if (cand.length % 2 === 0) { zs = cand; break }
    }
    if (zs === null) { badColumns++; segs[i * ny + j] = [] ; continue } // conservative: treated solid
    const list = []
    let prev = zBot
    for (let k = 0; k < zs.length; k += 2) {
      if (zs[k] - prev > 1e-6) list.push({ lo: prev, hi: zs[k], entry: Infinity })
      prev = zs[k + 1]
    }
    list.push({ lo: prev, hi: zTop, entry: Infinity })
    segs[i * ny + j] = list
  }

  // reverse flood (Dijkstra on entry level) from the plate plane upward
  const heap = [] // [entry, col, segIdx]
  const push = (e, c, s) => {
    heap.push([e, c, s])
    let i = heap.length - 1
    while (i > 0) { const par = (i - 1) >> 1; if (heap[par][0] <= heap[i][0]) break; [heap[par], heap[i]] = [heap[i], heap[par]]; i = par }
  }
  const pop = () => {
    const top = heap[0], last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let sm = i
        if (l < heap.length && heap[l][0] < heap[sm][0]) sm = l
        if (r < heap.length && heap[r][0] < heap[sm][0]) sm = r
        if (sm === i) break
        ;[heap[sm], heap[i]] = [heap[i], heap[sm]]; i = sm
      }
    }
    return top
  }
  for (let c = 0; c < nx * ny; c++) {
    const list = segs[c]
    if (list.length && list[0].lo <= zBot + 1e-9) { list[0].entry = list[0].lo; push(list[0].lo, c, 0) }
  }
  while (heap.length) {
    const [e, c, si] = pop()
    const seg = segs[c][si]
    if (e > seg.entry + 1e-12) continue // stale
    const ci = Math.floor(c / ny), cj = c % ny
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const i2 = ci + di, j2 = cj + dj
      if (i2 < 0 || i2 >= nx || j2 < 0 || j2 >= ny) continue
      const c2 = i2 * ny + j2
      const list = segs[c2]
      for (let k = 0; k < list.length; k++) {
        const ns = list[k]
        if (ns.hi < e || ns.lo > seg.hi) continue // no overlap with reachable [e, seg.hi]
        const e2 = Math.max(ns.lo, e)
        if (e2 < ns.entry - 1e-12) { ns.entry = e2; push(e2, c2, k) }
      }
    }
  }

  // violations: bounded air never reached (sealed / under a dome) or reached
  // only above its floor (resin pools deeper than poolTolMm)
  let sealedMm3 = 0, pooledMm3 = 0
  const worst = []
  const area = p * p
  for (let c = 0; c < nx * ny; c++) {
    const ci = Math.floor(c / ny), cj = c % ny
    for (const seg of segs[c]) {
      const bounded = seg.hi < zTop - 1e-9
      if (seg.entry === Infinity) {
        if (!bounded) continue // cannot happen for top segments, guard anyway
        const vol = (seg.hi - seg.lo) * area
        sealedMm3 += vol
        if (worst.length < 6) worst.push({ kind: 'sealed', printXY: [+(ox + (ci + 0.5) * p).toFixed(1), +(oy + (cj + 0.5) * p).toFixed(1)], floorZ: +seg.lo.toFixed(1), depthMm: +(seg.hi - seg.lo).toFixed(1) })
      } else if (seg.entry > seg.lo + poolTolMm) {
        const depth = Math.min(seg.entry, seg.hi) - seg.lo
        pooledMm3 += depth * area
        if (worst.length < 6) worst.push({ kind: 'pooled', printXY: [+(ox + (ci + 0.5) * p).toFixed(1), +(oy + (cj + 0.5) * p).toFixed(1)], floorZ: +seg.lo.toFixed(1), poolDepthMm: +depth.toFixed(1) })
      }
    }
  }
  const trappedMm3 = sealedMm3 + pooledMm3
  return {
    ok: trappedMm3 <= maxTrappedMm3,
    trappedMm3: +trappedMm3.toFixed(1),
    sealedAirMm3: +sealedMm3.toFixed(1),
    pooledMm3: +pooledMm3.toFixed(1),
    maxTrappedMm3, poolTolMm, colPitchMm: p,
    columns: nx * ny, badColumns,
    worst
  }
}

export function G3_cavities(part, opts = {}) {
  const m = part.manifold
  const genus = m.genus()
  const expected = part.meta?.expectedGenus ?? 0
  let componentGenus
  let genusOk = genus === expected
  if (part.meta?.components > 1) {
    const comps = m.decompose()
    componentGenus = comps.map((c) => { const g = c.genus(); c.delete(); return g })
    genusOk = genusOk && componentGenus.length === part.meta.components && componentGenus.every((g) => g >= 0)
  } else {
    genusOk = genusOk && genus >= 0 // −genus === 0: no print-sealed voids (printed parts)
  }
  const drain = drainability(m, part.printOrientation?.up ?? [0, 0, 1], opts)
  return {
    gate: 'G3', name: part.name, ok: genusOk && drain.ok,
    genus: { value: genus, expected, componentGenus, ok: genusOk, rule: '-genus()===0 for printed parts; vented parts declare expectedGenus in meta' },
    drain
  }
}

// ── G4 · plate fit in the declared print orientation ──────────────────────
export function G4_plateFit(part, { standoffMm = GATE.standoffMm, plate = PLATE.usable } = {}) {
  const { P, np } = meshArrays(part.manifold)
  const { u, v, w } = frameFromUp(part.printOrientation?.up ?? [0, 0, 1])
  let lu = Infinity, hu = -Infinity, lv = Infinity, hv = -Infinity, lw = Infinity, hw = -Infinity
  for (let i = 0; i < P.length; i += np) {
    const x = P[i], y = P[i + 1], z = P[i + 2]
    const a = x * u[0] + y * u[1] + z * u[2]
    const b = x * v[0] + y * v[1] + z * v[2]
    const c = x * w[0] + y * w[1] + z * w[2]
    if (a < lu) lu = a; if (a > hu) hu = a
    if (b < lv) lv = b; if (b > hv) hv = b
    if (c < lw) lw = c; if (c > hw) hw = c
  }
  const foot = [hu - lu, hv - lv].sort((a, b) => a - b)
  const plateXY = [plate[0], plate[1]].sort((a, b) => a - b)
  const height = hw - lw
  const footOk = foot[0] <= plateXY[0] + 1e-6 && foot[1] <= plateXY[1] + 1e-6
  const heightOk = height + standoffMm <= plate[2] + 1e-6
  return {
    gate: 'G4', name: part.name, ok: footOk && heightOk,
    footprintMm: foot.map((d) => +d.toFixed(1)),
    heightMm: +height.toFixed(1), standoffMm,
    heightWithStandoffMm: +(height + standoffMm).toFixed(1),
    plateUsable: plate, up: part.printOrientation?.up ?? [0, 0, 1],
    hardGate: PLATE.hardGate
  }
}

// ── G5 · J1–J6 clearance walker ───────────────────────────────────────────
/** Walks the §4 joint table (JOINTS, machine.mjs FIT) plus every fit any part
 *  declares in meta.fits: {joint, perSideMm|clearancePerSideMm (number|array),
 *  specPerSideMm?, note?}. ERROR on interference (≤0) and on any designed
 *  clearance below FIT.minTestableRadial ("below machine scatter — coupon
 *  required"); measured-vs-spec mismatches beyond g5MeasureTolMm also ERROR. */
export function G5_clearanceWalk(parts = [], { extraRows = [] } = {}) {
  const rows = []
  for (const j of JOINTS) rows.push({ source: 'machine-profile', ...j })
  for (const part of parts) {
    for (const f of part.meta?.fits ?? []) rows.push({ source: part.name, ...f })
  }
  rows.push(...extraRows.map((r) => ({ source: 'extra', ...r })))
  const out = rows.map((r) => {
    const vals = [r.perSideMm ?? r.clearancePerSideMm].flat().filter((x) => x !== undefined)
    const errors = []
    for (const c of vals) {
      if (c <= 0) errors.push(`INTERFERENCE ${c} mm/side — press fits BANNED in resin (D6)`)
      else if (c < FIT.minTestableRadial - 1e-9) errors.push(`${c} mm/side below machine scatter floor ${FIT.minTestableRadial} — coupon required (G5)`)
    }
    if (r.specPerSideMm !== undefined) {
      for (const c of vals) if (Math.abs(c - r.specPerSideMm) > GATE.g5MeasureTolMm)
        errors.push(`modeled ${c} vs specced ${r.specPerSideMm} mm/side (tol ${GATE.g5MeasureTolMm})`)
    }
    return { ...r, perSideMm: vals, ok: errors.length === 0, errors }
  })
  return {
    gate: 'G5', ok: out.every((r) => r.ok),
    minTestableRadial: FIT.minTestableRadial,
    rows: out
  }
}

// ── G6 · buoyancy/stability (delegates to hydroPlus) ──────────────────────
export function G6_stability(envelope, massItems, {
  stepDeg = 15, gmMinMm = 3, chambersCm3 = null, maxChamberCm3 = GATE.maxChamberCm3
} = {}) {
  const h = hydrostatics(envelope, massItems)
  const band = GATE.designBandFrac
  const draftOk = h.floats === true && h.draftFrac >= band[0] && h.draftFrac <= band[1]
  const sweep = gzSweep(envelope, massItems, stepDeg, { gmMinMm })
  let chambers = { declared: false, note: 'pass chambersCm3 (per sealed chamber) to gate sealed-air ≥ MASS.sealedAirCm3' }
  let chambersOk = true
  if (chambersCm3) {
    const sum = chambersCm3.reduce((a, b) => a + b, 0)
    const max = Math.max(...chambersCm3)
    chambersOk = sum >= MASS.sealedAirCm3 - 1e-9 && max <= maxChamberCm3
    chambers = { declared: true, chambersCm3, sumCm3: +sum.toFixed(1), requiredCm3: MASS.sealedAirCm3, maxSingleCm3: +max.toFixed(1), maxAllowedCm3: maxChamberCm3, ok: chambersOk }
  }
  return {
    gate: 'G6', ok: draftOk && sweep.ok && chambersOk,
    draft: { frac: h.draftFrac, band, ok: draftOk },
    hydro: h, gz: { ok: sweep.ok, gmT: sweep.gmT, minGZMm: sweep.minGZMm, steps: sweep.steps },
    chambers
  }
}

// ── G7 · mass manifest ────────────────────────────────────────────────────
export function G7_massManifest(parts, {
  ballastG = MASS.ballastNominalG,
  coatG = MASS.coatBudgetG,
  extras = [], // [{name, massG}] — non-printed or not-yet-modeled masses
  manifestPath = new URL('../parts/manifest.json', import.meta.url).pathname,
  note = null,
  write = true
} = {}) {
  const rows = parts.map((p) => {
    const volCm3 = p.manifold.volume() / 1000
    const qty = p.meta?.qty ?? 1
    return {
      part: p.name, qty,
      volCm3: +volCm3.toFixed(2),
      massEachG: +(volCm3 * RHO.resin).toFixed(1),
      massTotalG: +(volCm3 * RHO.resin * qty).toFixed(1)
    }
  })
  const printedG = rows.reduce((a, r) => a + r.massTotalG, 0)
  const extrasG = extras.reduce((a, e) => a + e.massG, 0)
  const allUpG = printedG + extrasG + ballastG + coatG
  const band = ellipsoidAnalytic.massBand(...GATE.designBandFrac) // §3: ρw·V_disp over 40–60 %
  const ok = allUpG >= band[0] && allUpG <= band[1]
  const manifest = {
    gate: 'G7', ok,
    generatedAt: new Date().toISOString(),
    rhoResinGCm3: RHO.resin,
    rows, extras,
    ballastG, coatBudgetG: coatG,
    totals: { printedG: +printedG.toFixed(1), extrasG: +extrasG.toFixed(1), allUpG: +allUpG.toFixed(1) },
    band: { minG: +band[0].toFixed(1), maxG: +band[1].toFixed(1), targetG: MASS.allUpG, deltaToTargetG: +(allUpG - MASS.allUpG).toFixed(1) },
    ownerCheck: 'weigh every part on a 0.1 g scale at assembly step 5 against massEachG — catches trapped uncured resin (§6-G7)',
    ...(note ? { note } : {})
  }
  if (write) {
    mkdirSync(new URL('../parts/', import.meta.url).pathname, { recursive: true })
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  }
  return { ...manifest, manifestPath: write ? manifestPath : null }
}

// ── convenience: run the whole per-part suite ─────────────────────────────
export function runAll(parts, { envelope = null, massItems = null, g6 = {}, g7 = {}, g2 = {}, g3 = {} } = {}) {
  const perPart = parts.map((p) => {
    const r1 = G1_manifoldRoundtrip(p)
    const r2 = G2_minWall(p, g2[p.name] ?? {})
    const r3 = G3_cavities(p, g3[p.name] ?? {})
    const r4 = G4_plateFit(p)
    return { name: p.name, ok: r1.ok && r2.ok && r3.ok && r4.ok, G1: r1, G2: r2, G3: r3, G4: r4 }
  })
  const g5 = G5_clearanceWalk(parts)
  const g7r = G7_massManifest(parts, g7)
  const g6r = envelope && massItems ? G6_stability(envelope, massItems, g6) : null
  return {
    ok: perPart.every((r) => r.ok) && g5.ok && g7r.ok && (g6r ? g6r.ok : true),
    perPart, G5: g5, G6: g6r, G7: g7r
  }
}

// ── self-test ─────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const Manifold = M()
  let allOk = true
  const check = (name, ok, detail = {}) => {
    allOk &&= ok
    console.log(JSON.stringify({ check: name, ok, ...detail }))
  }

  // reference solids (lib/manifold primitives; analytic walls & topology)
  const t = WALL.hull // 2.25 uniform shell
  const mk = {
    /** hollow sphere R20, wall exactly t, one Ø4 drain through the bottom pole → genus 0, drains at floor */
    sphereShell() {
      const outer = Manifold.sphere(20, 96)
      const inner = Manifold.sphere(20 - t, 96)
      const drain = Manifold.cylinder(6, 2, 2, 64).translate([0, 0, -21])
      const shell = outer.subtract(inner)
      const part = shell.subtract(drain)
      outer.delete(); inner.delete(); drain.delete(); shell.delete()
      return {
        name: 'ref-sphere-shell', manifold: part,
        printOrientation: { up: [0, 0, 1], note: 'drain hole down — cavity opens at its floor' },
        meta: { qty: 1, expectedGenus: 0, minWallMm: WALL.hullFloor, analyticWallMm: t }
      }
    },
    /** hollow box 60×40×30, wall t, Ø4 drain through the floor → genus 0 */
    boxShell(name = 'ref-box-shell', holeAtTop = false, wall = t) {
      const outer = Manifold.cube([60, 40, 30], true)
      const inner = Manifold.cube([60 - 2 * wall, 40 - 2 * wall, 30 - 2 * wall], true)
      const hole = Manifold.cylinder(wall + 2, 2, 2, 64).translate([0, 0, holeAtTop ? 15 - wall - 1 : -15 - 1])
      const shell = outer.subtract(inner)
      const part = shell.subtract(hole)
      outer.delete(); inner.delete(); hole.delete(); shell.delete()
      return {
        name, manifold: part,
        printOrientation: { up: [0, 0, 1], note: holeAtTop ? 'NEGATIVE REF: only opening at the TOP — dome rule must flag' : 'drain hole down' },
        meta: { qty: 1, expectedGenus: 0, minWallMm: Math.min(wall, WALL.hullFloor), analyticWallMm: wall }
      }
    },
    sealedBox() {
      const outer = Manifold.cube([40, 30, 20], true)
      const inner = Manifold.cube([40 - 2 * t, 30 - 2 * t, 20 - 2 * t], true)
      const part = outer.subtract(inner)
      outer.delete(); inner.delete()
      return {
        name: 'ref-sealed-box', manifold: part,
        printOrientation: { up: [0, 0, 1], note: 'NEGATIVE REF: print-sealed cavity' },
        meta: { qty: 1, expectedGenus: 0 }
      }
    }
  }

  // ── positive path: both printable refs through G1–G4 ────────────────────
  const goodParts = [mk.sphereShell(), mk.boxShell()]
  for (const part of goodParts) {
    const r1 = G1_manifoldRoundtrip(part)
    const r2 = G2_minWall(part)
    const wallNear = r2.minWallSampledMm !== null && Math.abs(r2.minWallSampledMm - part.meta.analyticWallMm) < 0.15
    const r3 = G3_cavities(part)
    const r4 = G4_plateFit(part)
    check(`${part.name}-G1-G4`, r1.ok && r2.ok && wallNear && r3.ok && r4.ok, {
      G1: { ok: r1.ok, volCm3: r1.volumeCm3, roundTrip: r1.roundTrip, stl: r1.stlPath },
      G2: { ok: r2.ok, minWallSampledMm: r2.minWallSampledMm, analyticWallMm: part.meta.analyticWallMm, wallSamples: r2.wallSamples, grazing: r2.grazing, violations: r2.violations },
      G3: { ok: r3.ok, genus: r3.genus.value, trappedMm3: r3.drain.trappedMm3 },
      G4: { ok: r4.ok, footprintMm: r4.footprintMm, heightWithStandoffMm: r4.heightWithStandoffMm }
    })
  }

  // ── negative path: every failure mode must be DETECTED ──────────────────
  {
    const bad = mk.boxShell('ref-dome-trap', true) // opening only at the TOP
    const r3 = G3_cavities(bad)
    check('detects-dome-without-low-drain', r3.ok === false && r3.genus.ok === true && r3.drain.ok === false,
      { genus: r3.genus.value, trappedMm3: r3.drain.trappedMm3, sealedAirMm3: r3.drain.sealedAirMm3, worst: r3.drain.worst.slice(0, 2) })
    bad.manifold.delete()
  }
  {
    const bad = mk.sealedBox() // no opening at all
    const r3 = G3_cavities(bad)
    check('detects-print-sealed-cavity', r3.ok === false && r3.genus.value === -1 && r3.genus.ok === false && r3.drain.ok === false,
      { genus: r3.genus.value, sealedAirMm3: r3.drain.sealedAirMm3 })
    bad.manifold.delete()
  }
  {
    const thin = mk.boxShell('ref-thin-wall', false, 1.2) // wall 1.2 < 2.0 floor
    const r2 = G2_minWall(thin, { minWallMm: WALL.hullFloor })
    check('detects-thin-wall', r2.ok === false && r2.minWallSampledMm < 1.35,
      { minWallSampledMm: r2.minWallSampledMm, requiredMm: r2.requiredMm.hull, violations: r2.violations })
    thin.manifold.delete()
  }
  {
    const tall = {
      name: 'ref-too-tall', manifold: Manifold.cube([10, 10, 141], true),
      printOrientation: { up: [0, 0, 1] }, meta: {}
    }
    const r4 = G4_plateFit(tall) // 141 + 6 standoff > 145 usable Z
    check('detects-plate-overflow-with-standoff', r4.ok === false, { heightWithStandoffMm: r4.heightWithStandoffMm, plateZ: PLATE.usable[2] })
    tall.manifold.delete()
  }
  {
    // G4 must respect the DECLARED orientation: 100 long lying flat fits;
    // the same part declared up along its long axis is 100+6 tall — still
    // fits Z=145, but footprint sorted-fit must be orientation-aware:
    const flat = { name: 'ref-flat', manifold: Manifold.cube([100, 60, 20], true), printOrientation: { up: [0, 0, 1] }, meta: {} }
    const onEnd = { name: 'ref-on-end', manifold: Manifold.cube([100, 60, 20], true), printOrientation: { up: [1, 0, 0] }, meta: {} }
    const rFlat = G4_plateFit(flat)
    const rEnd = G4_plateFit(onEnd)
    // flat: footprint 100×60 ≤ 120×72 ✓ ; on-end: footprint 60×20, height 106 ✓
    check('G4-orientation-aware', rFlat.ok && rEnd.ok && rFlat.heightMm === 20 && rEnd.heightMm === 100,
      { flat: { foot: rFlat.footprintMm, h: rFlat.heightMm }, onEnd: { foot: rEnd.footprintMm, h: rEnd.heightMm } })
    flat.manifold.delete() // onEnd shares no manifold — separate cube
    onEnd.manifold.delete()
  }

  {
    // spec §2 shell vents are HORIZONTAL Ø3 holes: the dome rule must treat a
    // side vent as an opening only down to its LIP ("at or below the floor").
    const sideVentBox = (name, ventCenterZ) => {
      const outer = Manifold.cube([60, 40, 30], true)
      const inner = Manifold.cube([60 - 2 * t, 40 - 2 * t, 30 - 2 * t], true)
      const vent = Manifold.cylinder(t + 2, 1.5, 1.5, 48).rotate([0, 90, 0]).translate([30 - t - 1, 0, ventCenterZ])
      const shell = outer.subtract(inner)
      const part = shell.subtract(vent)
      outer.delete(); inner.delete(); vent.delete(); shell.delete()
      return { name, manifold: part, printOrientation: { up: [0, 0, 1] }, meta: { expectedGenus: 0 } }
    }
    const floorZ = -(15 - t) // cavity floor −12.75
    const good = sideVentBox('ref-side-vent-at-floor', floorZ + 1.5) // lip exactly at the floor
    const bad = sideVentBox('ref-side-vent-too-high', 0) // lip 11.25 above the floor
    const rGood = G3_cavities(good)
    const rBad = G3_cavities(bad)
    check('G3-side-vent-lip-rule', rGood.ok === true && rBad.ok === false && rBad.drain.pooledMm3 > 10000,
      { atFloor: { ok: rGood.ok, trappedMm3: rGood.drain.trappedMm3 }, tooHigh: { ok: rBad.ok, pooledMm3: rBad.drain.pooledMm3, worst: rBad.drain.worst[0] } })
    good.manifold.delete(); bad.manifold.delete()
  }
  {
    // G2 boss threshold: the same 2.25 shell must FAIL where a declared boss
    // region demands WALL.boss = 3.0
    const sph = mk.sphereShell()
    const r2 = G2_minWall(sph, { bossRegions: [{ min: [-25, -25, -25], max: [25, 25, 25] }] })
    check('G2-boss-threshold-applies', r2.ok === false && r2.worst[0]?.requiredMm === WALL.boss,
      { minWallSampledMm: r2.minWallSampledMm, bossMinMm: WALL.boss, violations: r2.violations })
    sph.manifold.delete()
  }

  // ── G5: machine-profile walk + declared fits + error detection ──────────
  {
    const withFits = { name: 'meta-fits-carrier', manifold: null, printOrientation: null, meta: { fits: [
      { joint: 'J2', name: 'modeled hinge gap', perSideMm: 0.25, specPerSideMm: FIT.hingeRadial }
    ] } }
    const good = G5_clearanceWalk([withFits])
    const bad = G5_clearanceWalk([], { extraRows: [
      { joint: 'TEST', name: 'interference', perSideMm: -0.05 },
      { joint: 'TEST', name: 'below-floor', perSideMm: 0.03 },
      { joint: 'TEST', name: 'measured-vs-spec-mismatch', perSideMm: 0.25, specPerSideMm: 0.15 }
    ] })
    const badRows = bad.rows.filter((r) => !r.ok)
    check('G5-walker', good.ok === true && bad.ok === false && badRows.length === 3,
      { baselineRows: good.rows.map((r) => `${r.joint}:${r.perSideMm}mm:${r.ok ? 'ok' : 'ERR'}`), detected: badRows.map((r) => r.errors[0]) })
  }

  // ── G6: envelope + spec §3 ledger + chamber declaration ─────────────────
  const { a, b, c } = ENVELOPE
  const ell = Manifold.sphere(c, 128).scale([a / c, b / c, 1])
  const ZB_KEEL = 15.75 // spec §3/§8 row 13
  const items = [
    { point: [0, 0, 0], massG: MASS.allUpG - MASS.ballastNominalG },
    { point: [0, 0, ZB_KEEL - c], massG: MASS.ballastNominalG }
  ]
  {
    const r6 = G6_stability(ell, items, { chambersCm3: [80, 79, 112, 111] }) // §3 air ledger
    check('G6-stability-gate', r6.ok === true && r6.gz.gmT > 3 && r6.gz.minGZMm > 0 && r6.chambers.ok === true,
      { draftFrac: r6.draft.frac, gmT: r6.gz.gmT, minGZMm: r6.gz.minGZMm, chambers: r6.chambers })
    // and the failure direction: starve the sealed air
    const rBad = G6_stability(ell, items, { chambersCm3: [80, 79, 112] })
    check('G6-detects-air-shortfall', rBad.ok === false && rBad.chambers.ok === false, { sumCm3: rBad.chambers.sumCm3, requiredCm3: rBad.chambers.requiredCm3 })
  }

  // ── G7: manifest with the spec §3 ledger stand-ins ──────────────────────
  {
    const band = ellipsoidAnalytic.massBand(...GATE.designBandFrac)
    const r7 = G7_massManifest(goodParts, {
      extras: [{ name: 'demo-structure-stand-in (remaining pods/tail/fins)', massG: 140 }],
      manifestPath: new URL('../parts/manifest.selftest.json', import.meta.url).pathname,
      note: 'SELF-TEST manifest over reference solids — the production manifest is regenerated by running G7 over the full P1–P8 part list (defaults to parts/manifest.json)'
    })
    const bandOk = Math.abs(band[0] - 198) < 1 && Math.abs(band[1] - 365) < 1 // spec §3: 198–365 g
    check('G7-mass-manifest', r7.ok === true && bandOk,
      { totals: r7.totals, band: r7.band, manifest: r7.manifestPath })
  }

  // ── runAll: the wrapper the integrator calls over the real P1–P8 list ───
  {
    const ra = runAll(goodParts, {
      envelope: ell, massItems: items,
      g6: { chambersCm3: [80, 79, 112, 111] },
      g7: {
        extras: [{ name: 'demo-structure-stand-in (remaining pods/tail/fins)', massG: 140 }],
        manifestPath: new URL('../parts/manifest.selftest.json', import.meta.url).pathname,
        note: 'SELF-TEST manifest over reference solids — regenerate over the full P1–P8 list (defaults to parts/manifest.json)'
      }
    })
    check('runAll-wrapper', ra.ok === true,
      { perPart: ra.perPart.map((r) => `${r.name}:${r.ok}`), G5: ra.G5.ok, G6: ra.G6.ok, G7: ra.G7.ok })
  }

  ell.delete()
  for (const p of goodParts) p.manifold.delete()
  console.log(JSON.stringify({ verdict: allOk ? 'GREEN' : 'RED', module: 'gates.mjs' }))
  process.exit(allOk ? 0 : 1)
}
