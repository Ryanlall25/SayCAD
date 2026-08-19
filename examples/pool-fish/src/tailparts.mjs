// tailparts.mjs — J2 tail hinge: clevisFork() (unions into P2), P3 free-flooding
// tail, P4 printed pin fallback + P4a retainer caps, and stopCheck(), the
// digital ±30° swing proof (spec §2 P2–P4a, §4 J2).
//
// Local hinge frame: pin axis = Z at the origin; +X aft. Global placement:
// axis at x = HINGE.axisGlobalX (pods.mjs translates the fork; tailAssembly()
// is returned already in the GLOBAL frame).
//
// Stop geometry (the part that must be exactly right): the peduncle root has
// FLAT vertical flanks at y = ±FLANK_Y. Each stop column carries a flat face
// lying in the plane p·n = FLANK_Y with n = (∓sin30°, ±cos30°) — precisely
// where the flank plane lands after a ±30° yaw about the pin. Contact is
// therefore plane-on-plane (flush), patch ≈ 3.3 × 10 mm ≥ 3×3 (J2), and the
// no-interference-below-30° claim is proven volumetrically in stopCheck().
import { boot, M, CS, loft, writeSTL } from '../lib.mjs'
import { FIT, PLATE, WALL } from './machine.mjs'
import { G1_manifoldRoundtrip, G2_minWall, G3_cavities, G4_plateFit } from './gates.mjs'

const PIN_D = 6.0
const BORE_R = (PIN_D + 2 * FIT.hingeRadial) / 2 // Ø6.5 (J2: female carries clearance)
const KNUCKLE_R = BORE_R + WALL.boss // 6.25 → knuckle OD 12.5, wall 3.0
const FLANK_Y = 5.2 // peduncle flat-flank half-width (stop contact plane)
const STOP_DEG = 30
const AXIAL_GAP = 1.75 // body–tail knuckle float (spec band 1.5–2.0)
const BAND = { zIn: 14, zOut: 22 } // fork knuckle bands: z ∈ ±[14, 22] → span 44 (spec 40–45)
const TAIL_KNUCKLE_HZ = BAND.zIn - AXIAL_GAP // ±12.25 → height 24.5

export const HINGE = {
  axisGlobalX: 107, // pin axis station; transom face at x=+100, knuckle clears it by 0.75
  pinD: PIN_D, boreD: PIN_D + 2 * FIT.hingeRadial, knuckleOD: 2 * KNUCKLE_R,
  forkSpanMm: 2 * BAND.zOut, stopDeg: STOP_DEG, axialGapMm: AXIAL_GAP,
  aftmostXLocal: 9, // fork cap plates end here — pods print-height budget
  pin: { shankTopZ: BAND.zOut, shankBotZ: BAND.zOut - 50, headD: 9, headH: 2 } // z 22 → −28
}

function ok(m, what) {
  const s = String(m.status()?.value ?? m.status())
  if (s !== '0' && s !== 'NoError') throw new Error(`${what}: manifold status ${s}`)
  return m
}

// ── ring builders (rings live in the y–z plane at station x = s) ──────────
/** radial rounded-rect: half-width w (y), half-height h (z), corner radius rc.
 *  Flat sides at |y| = w over |z| ≤ h − rc — the stop-contact flats. */
function ringRR(s, w, h, rc, n = 192) {
  const sdf = (y, z) => {
    const qy = Math.max(Math.abs(y) - (w - rc), 0)
    const qz = Math.max(Math.abs(z) - (h - rc), 0)
    return Math.hypot(qy, qz) - rc
  }
  const ring = []
  for (let j = 0; j < n; j++) {
    const phi = (2 * Math.PI * j) / n
    const t = phi + (APEX_WARP / 2) * Math.sin(2 * phi) // same warp as ringSE — loft correspondence
    const cy = Math.cos(t), cz = Math.sin(t)
    let lo = 0.01, hi = w + h + 1
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2
      if (sdf(mid * cy, mid * cz) < 0) lo = mid
      else hi = mid
    }
    const r = (lo + hi) / 2
    ring.push([s, r * cy, r * cz])
  }
  return ring
}

/** superellipse blade section UNIONED (pointwise-max radius) with a RIM_R
 *  stadium so the rim carries a true ≥0.6 bullnose (spec §2 P3 edge radius)
 *  instead of the superellipse's near-knife apex (ry²/rz ≈ 0.05).
 *
 *  TESSELLATION (the part an earlier revision got wrong): the bullnose cap
 *  subtends only atan(RIM_R/(rz−RIM_R)) ≈ 1° at the origin, so uniform-θ
 *  sampling at n=64 (5.6° pitch) steps straight past it and the BUILT MESH is
 *  a knife edge even though the continuous section is round. APEX_WARP
 *  reparametrizes θ(φ) = φ + (k/2)·sin 2φ, which is monotone for k<1 and
 *  compresses the sample spacing near θ = ±90° (the z-apexes) by (1−k) — at
 *  k=0.92 / n=192 the cap gets ~9 vertices. The warp is identical for every
 *  ring, so loft correspondence is unchanged. rimProof() in the self-test
 *  measures the delivered mesh; the comment is not the evidence. */
// 0.9, not the spec floor of 0.6: a vertical section through a rim that climbs
// (drz/ds reaches 1.3 on this planform) cuts the swept edge obliquely and reads
// ~0.87 of the true radius, and the ray sampler under-reads a convex rim the
// same way. Designing the edge 50 % blunter than the floor means every
// instrument — rimProof's caliper AND G2's whole-part sweep at 1.25 — clears
// spec without a single exclusion or tolerance argument.
const RIM_R = 0.9
const APEX_WARP = 0.92
export function ringSE(s, ry, rz, p, n = 192) {
  // union tested point-wise (both shapes are star-shaped about the origin, so
  // the union boundary is a single crossing along every ray — bisect it)
  const inside = (y, z) => {
    const se = (Math.abs(y) / ry) ** p + (Math.abs(z) / rz) ** p <= 1
    const qz = Math.max(Math.abs(z) - (rz - RIM_R), 0)
    const stadium = Math.hypot(Math.abs(y), qz) <= RIM_R
    return se || stadium
  }
  const ring = []
  for (let j = 0; j < n; j++) {
    const phi = (2 * Math.PI * j) / n
    const t = phi + (APEX_WARP / 2) * Math.sin(2 * phi)
    const c = Math.cos(t), sn = Math.sin(t)
    let lo = 0.01, hi = rz + 2
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2
      if (inside(mid * c, mid * sn)) lo = mid
      else hi = mid
    }
    const r = (lo + hi) / 2
    ring.push([s, r * c, r * sn])
  }
  return ring
}

/** loft with winding auto-correction for X-stacked rings (lib.loft was proven
 *  on Z-stacked rings; an inverted result is rebuilt with reversed rings). */
function loftX(rings) {
  const attempt = (rs) => {
    const m = loft(rs)
    if (m.volume() <= 0) { m.delete(); throw new Error('inverted loft') }
    return m
  }
  try { return attempt(rings) } catch { return attempt(rings.map((r) => [...r].reverse())) }
}

// ── clevis fork (unions into P2 at [HINGE.axisGlobalX, 0, 0]) ─────────────
/** Stop-column plan footprint: face edge from t=7.5 to t=12 along the contact
 *  plane p·n = FLANK_Y, body extruded 2.8 behind it, face-edge corners
 *  chamfered 0.7 in the polygon itself. */
function columnFootprint() {
  const s30 = Math.sin((STOP_DEG * Math.PI) / 180), c30 = Math.cos((STOP_DEG * Math.PI) / 180)
  const n = [-s30, c30] // contact-plane normal (+Y column)
  const d = [c30, s30] // along the contact plane, outward
  const P = (t, back = 0) => [FLANK_Y * n[0] + t * d[0] + back * n[0], FLANK_Y * n[1] + t * d[1] + back * n[1]]
  const A = P(7.5), B = P(12), C = P(12, 2.8), D = P(7.5, 2.8)
  const off = (p, q, len) => {
    const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy)
    return [p[0] + (dx / L) * len, p[1] + (dy / L) * len]
  }
  // CCW: chamfer the two face-edge corners (A toward B/D, B toward A/C)
  return [off(A, B, 0.7), off(B, A, 0.7), off(B, C, 0.7), C, D, off(A, D, 0.7)]
}

export function clevisFork() {
  const Manifold = M()
  const CrossSection = CS()
  const pieces = []
  for (const sz of [1, -1]) { // knuckle bands + yoke (to transom) + aft cap plates
    const zc = sz * (BAND.zIn + BAND.zOut) / 2
    pieces.push(Manifold.cube([9, 16, 8], true).translate([-4.5, 0, zc])) // yoke: x −9…0 (crosses transom at x_local −7)
    pieces.push(Manifold.cube([9, 27, 8], true).translate([4.5, 0, zc])) // cap: x 0…9, y ±13.5 (free water aft of transom)
  }
  const foot = columnFootprint()
  for (const sy of [1, -1]) {
    const pts = foot.map(([x, y]) => [x, sy * y])
    if (sy < 0) pts.reverse() // keep CCW
    const cs = new CrossSection([pts])
    pieces.push(cs.extrude(32).translate([0, 0, -16])) // column bridges the bands, 2 mm embedded each end
    const collarCS = cs.offset(1.2, 'Round') // stepped collars ≈ r≥1 root fillets (spec §5 clevis.js note)
    pieces.push(collarCS.extrude(3.5).translate([0, 0, -16]))
    pieces.push(collarCS.extrude(3.5).translate([0, 0, 12.5]))
    collarCS.delete(); cs.delete()
  }
  let fork = pieces[0]
  for (let i = 1; i < pieces.length; i++) {
    const next = fork.add(pieces[i])
    fork.delete(); pieces[i].delete()
    fork = next
  }
  const bore = Manifold.cylinder(46, BORE_R, BORE_R, 96).translate([0, 0, -23])
  const done = ok(fork.subtract(bore), 'clevisFork')
  fork.delete(); bore.delete()
  return {
    name: 'p2-clevis-fork',
    manifold: done, // LOCAL hinge frame — pods.mjs translates by [HINGE.axisGlobalX, 0, 0]
    printOrientation: { up: [1, 0, 0], note: 'prints as part of P2 (rim down, +X up); never printed alone' },
    meta: {
      partOf: 'P2', unionAt: [HINGE.axisGlobalX, 0, 0],
      knuckles: `2× bore Ø${(2 * BORE_R).toFixed(1)}, wall ${WALL.boss}, span ${2 * BAND.zOut} (spec 40–45)`,
      stops: `±${STOP_DEG}° radial-plane faces (flush contact on the peduncle flats), patch ≈3.3×10 mm ≥3×3, face edges chamfered 0.7`,
      filletNote: 'column roots carry 1.2 mm stepped offset-Round collars approximating the r≥1 fillets',
      fits: [
        { joint: 'J2', name: 'fork bores Ø6.5 on Ø6.0 pin (×2)', perSideMm: FIT.hingeRadial, kind: 'radial' }
      ]
    }
  }
}

// ── P3 tail (knuckle + free-flooding peduncle + caudal blade) ─────────────
const OUTER_STATIONS = [
  { kind: 'rr', s: 4.8, w: FLANK_Y, h: 6.8, rc: 2.0 },
  { kind: 'rr', s: 8.0, w: FLANK_Y, h: 7.2, rc: 2.0 },
  { kind: 'rr', s: 11.0, w: FLANK_Y, h: 7.8, rc: 2.0 },
  { kind: 'rr', s: 13.0, w: FLANK_Y, h: 8.2, rc: 2.0 }, // flat flank band ends (stop contact r 8.7–13.9)
  { kind: 'se', s: 15.0, ry: 4.4, rz: 9.5, p: 2.6 },
  { kind: 'se', s: 18.0, ry: 3.4, rz: 14.0, p: 2.4 }, // root fillet zone (~3–4 blend)
  { kind: 'se', s: 22.0, ry: 1.9, rz: 21.0, p: 2.2 },
  { kind: 'se', s: 27.0, ry: 1.4, rz: 27.5, p: 2.2 },
  { kind: 'se', s: 33.0, ry: 1.3, rz: 32.0, p: 2.2 },
  { kind: 'se', s: 40.0, ry: 1.3, rz: 35.0, p: 2.2 },
  { kind: 'se', s: 46.0, ry: 1.3, rz: 36.8, p: 2.2 },
  { kind: 'se', s: 51.0, ry: 1.25, rz: 37.5, p: 2.2 }, // span 75 (planform ~45×75)
  { kind: 'se', s: 53.0, ry: 1.0, rz: 36.0, p: 2.2 }
]
// Hollow peduncle cavity, walls ≥1.8 (spec D7). The cavity STOPS at s=13.0,
// the last station of the constant-flank (w=5.2) outer run: aft of it the
// outer loft blends rr→se fast (ry 5.2→4.4, rz 8.2→9.5 over 2 mm), and an
// in-plane inset there buys only inset·cos(slope) ≈ 0.84·1.8 = 1.5 mm of true
// wall — the dip a wall audit caught. Blend zone is now SOLID resin (it also
// lifts the tail's dry mass toward the spec's 25–40 g target). Inside the
// constant-flank run the outer slope is ≤0.2/mm (cos ≥ 0.98), so the inset
// IS the wall: w 5.2−1.8 = 3.4, h = h_outer − 1.8+, corner rc 1.4 > the exact
// offset's 0.2 (a rounder cavity corner = more material, conservative).
const CAVITY_STATIONS = [
  { s: 7.0, w: 3.4, h: 4.6, rc: 1.4 },
  { s: 9.0, w: 3.4, h: 5.3, rc: 1.4 },
  { s: 11.5, w: 3.4, h: 6.0, rc: 1.4 },
  { s: 12.6, w: 3.4, h: 6.2, rc: 1.4 } // outer here: w 5.2 / h 8.12 → walls 1.80 / 1.92
]
// Why 12.6 and not 13.0: the wall aft of the cavity's end cap is measured
// PERPENDICULAR to the sloping outer flank, not across the section. From the
// end-cap corner (s, 3.4) the nearest outer point at s=13.0 is 1.68 mm away
// (flank y falls 0.4/mm aft of s=13) — the dip a 13.0 end still showed. At
// 12.6 the nearest outer point is the straight-out 1.80. wallProof() measures
// it; this comment only explains the number.
const TAIL_TILT_DEG = 15 // blade ~75° from plate (spec P3); G4 sorts footprint → diagonal placement fits

/** G2 rim-exclusion staircase: per 4 mm of global x, exclude |z| above the
 *  local blade half-height minus the bullnose flank drop (rim chords are the
 *  designed 0.65-radius edge, not walls). */
/* retired: chord staircase superseded by the constructive blade certificate */
function rimStaircaseBoxes() {
  const rzAtS = (s) => {
    const st = OUTER_STATIONS
    for (let i = 0; i < st.length - 1; i++) {
      const a = st[i], b = st[i + 1]
      if (s >= a.s && s <= b.s) {
        const ra = a.rz ?? a.h, rb = b.rz ?? b.h
        return ra + ((s - a.s) / (b.s - a.s)) * (rb - ra)
      }
    }
    return 37.5
  }
  const boxes = []
  for (let x0 = 124; x0 < 157; x0 += 4) {
    const zLo = Math.max(9, rzAtS(x0 - HINGE.axisGlobalX) - 3.2)
    boxes.push({ min: [x0, -7, zLo], max: [x0 + 4, 7, 40] })
    boxes.push({ min: [x0, -7, -40], max: [x0 + 4, 7, -zLo] })
  }
  return boxes
}

function tailLocal() {
  const Manifold = M()
  const rings = OUTER_STATIONS.map((st) =>
    st.kind === 'rr' ? ringRR(st.s, st.w, st.h, st.rc) : ringSE(st.s, st.ry, st.rz, st.p))
  const body = loftX(rings)
  const knuckle = Manifold.cylinder(2 * TAIL_KNUCKLE_HZ, KNUCKLE_R, KNUCKLE_R, 96)
    .translate([0, 0, -TAIL_KNUCKLE_HZ])
  const solid = ok(body.add(knuckle), 'tail body+knuckle')
  body.delete(); knuckle.delete()

  const cavity = loftX(CAVITY_STATIONS.map((st) => ringRR(st.s, st.w, st.h, st.rc)))
  // openings STAY OPEN in service; all three now pierce the shortened cavity
  const holes = [
    Manifold.cylinder(6.5, 1.5, 1.5, 48).translate([9.0, 0, -9.0]), // flood Ø3 low (z −9…−2.5)
    Manifold.cylinder(6.5, 1.5, 1.5, 48).translate([12.2, 0, -9.5]), // flood Ø3 low/aft — clear of hole 1's x-span (overlap would merge them into one opening)
    Manifold.cylinder(6.0, 1.0, 1.0, 48).translate([12.0, 0, 4.0]) // vent Ø2 high through the roof
  ]
  const bore = Manifold.cylinder(26, BORE_R, BORE_R, 96).translate([0, 0, -13])
  // J2 "domed lower thrust face" ≈ 1.5 × 45° under-chamfer on the knuckle bottom edge
  const chamferOuter = Manifold.cylinder(1.6, 7.5, 7.5, 96).translate([0, 0, -12.3])
  const chamferCone = Manifold.cylinder(1.6, KNUCKLE_R - 1.4, KNUCKLE_R + 0.2, 96).translate([0, 0, -12.3])
  const chamferRing = chamferOuter.subtract(chamferCone)
  chamferOuter.delete(); chamferCone.delete()

  let m = ok(solid.subtract(cavity), 'tail −cavity')
  solid.delete(); cavity.delete()
  for (const cut of [...holes, bore, chamferRing]) {
    const next = ok(m.subtract(cut), 'tail cut')
    m.delete(); cut.delete()
    m = next
  }
  return m
}

export function tailAssembly() {
  const local = tailLocal()
  const manifold = local.translate([HINGE.axisGlobalX, 0, 0]) // GLOBAL frame
  local.delete()
  const volCm3 = manifold.volume() / 1000
  const t = (TAIL_TILT_DEG * Math.PI) / 180
  return {
    name: 'p3-tail-assembly',
    manifold,
    printOrientation: {
      up: [Math.sin(t), 0, Math.cos(t)],
      note: 'blade ~75° from plate, root + leading edge low (supports there only); place diagonally on the plate'
    },
    meta: {
      qty: 1,
      expectedGenus: 3,
      genusNote: 'free-flooding by design: hollow peduncle with 2 flood + 1 vent hole = 2 handles, + Ø6.5 hinge bore = 3; zero print-sealed cavities (−genus ≤ 0 impossible here)',
      // 1.25 floor = the blade rim's designed 2·RIM_R = 1.3 bullnose thickness
      // less polygon faceting. NO blade exclusion: the whole part is sampled,
      // so a knife edge anywhere fails this gate. The rim's edge radius itself
      // is measured on the delivered mesh by rimProof(), not asserted here.
      minWallMm: 1.25,
      minWallNote: 'design walls: peduncle 1.8 (cavity stops at s=13.0, blend zone solid), blade 2.5–3.8 lens closing on a 0.65-radius bullnose rim (thickness floor 1.3), knuckle 3.0',
      excludeRegions: [
        // flood-hole + vent rim wedges only: Ø3/Ø2 spec'd openings, where a
        // chord along the outer surface crosses the aperture instead of a wall
        { min: [114.7, -2.8, -10], max: [121.0, 2.8, -2.5] },
        { min: [117.8, -2.3, 3], max: [120.0, 2.3, 10] }
      ],
      floodHoles: '2× Ø3.0 low/aft + 1× Ø2.0 vent high — STAY OPEN (service: floods, sheds air)',
      dryMassG: +(volCm3 * 1.15).toFixed(1),
      floodedSubmergedGf: +(volCm3 * (1.15 - 0.997)).toFixed(1),
      massNote: 'submerged weight sits in the spec band +1…+5 gf (the J2-functional number); dry mass runs under the soft 25–40 g target — mesh supersedes the estimate, ballast absorbs the delta (§3)',
      fits: [
        { joint: 'J2', name: 'tail knuckle bore Ø6.5 on Ø6.0 pin', perSideMm: FIT.hingeRadial, kind: 'radial' },
        { joint: 'J2', name: 'knuckle axial float (per side)', perSideMm: AXIAL_GAP, kind: 'axial', note: 'spec band 1.5–2.0; domed thrust face approximated by 1.5×45° under-chamfer' }
      ],
      serviceNote: 'bores and pin stay unpainted; hand-ream Ø6.5 bores with a Ø6.0 drill after cure (assembly step 5)'
    }
  }
}

// ── P4 hinge pin (printed fallback; preferred part is cut Ø6 HDPE rod) ────
export function hingePin() {
  const Manifold = M()
  const head = Manifold.cylinder(2, 4.5, 4.5, 96) // Ø9×2 head, on the plate
  const shank = Manifold.cylinder(50, 3.0, 3.0, 96).translate([0, 0, 2])
  const drill = Manifold.cylinder(12, 0.75, 0.75, 48).translate([0, 0, -6]).rotate([90, 0, 0]).translate([0, 0, 47])
  const joined = head.add(shank)
  const manifold = ok(joined.subtract(drill), 'hingePin')
  head.delete(); shank.delete(); drill.delete(); joined.delete()
  return {
    name: 'p4-hinge-pin',
    manifold,
    printOrientation: { up: [0, 0, 1], note: 'vertical, head down on the plate' },
    meta: {
      qty: 2, // 1 + 1 spare
      expectedGenus: 1,
      genusNote: 'Ø1.5 cross-drill through-tunnel (cotter fallback); sits in the exposed 2 mm gap above the retainer cap in assembly',
      material: 'FALLBACK — spec P4 prefers cut Ø6.0 HDPE rod (purchased); print only if no rod',
      fits: [{ joint: 'J2', name: 'Ø6.0 pin in Ø6.5 bores', perSideMm: FIT.hingeRadial, kind: 'radial' }]
    }
  }
}

// ── P4a retainer cap ──────────────────────────────────────────────────────
export function retainerCap() {
  const Manifold = M()
  const body = Manifold.cylinder(6, 4.5, 4.5, 96)
  const bore = Manifold.cylinder(4, 3.05, 3.05, 96) // blind Ø6.1×4 (J6: snug by design)
  const manifold = ok(body.subtract(bore), 'retainerCap')
  body.delete(); bore.delete()
  return {
    name: 'p4a-retainer-cap',
    manifold,
    printOrientation: { up: [0, 0, 1], note: 'bore mouth DOWN on a standoff (vents — no cup); solid crown up' },
    meta: {
      qty: 2,
      expectedGenus: 0,
      fits: [{ joint: 'J6', name: 'Ø6.1 blind bore on Ø6.0 pin', perSideMm: 0.05, kind: 'radial', note: 'snug by design — neutral-cure silicone dab, serviceable (spec §4 J6)' }]
    }
  }
}

// ── rim + wall proofs (measure the BUILT MESH, never the intent) ──────────
/** Blade rim edge radius, measured the way a caliper would: at each station,
 *  find the mesh's rim tip (max |z| of material), then measure the full
 *  thickness of a thin slab 0.6 mm inboard of it. A true R bullnose measures
 *  2·√(R²−(R−0.6)²) there — 1.296 mm at R=0.65, and only ~0.1 mm on the
 *  knife edge an unwarped tessellation produces. Gate: ≥1.15 mm (faceting
 *  allowance), which corresponds to an effective edge radius ≥0.6 (spec P3). */
export function rimProof(manifold, { inboardMm = 0.6, minThicknessMm = 1.2 } = {}) {
  const slabBounds = (xLo, xHi, zLo, zHi) => {
    const a = manifold.trimByPlane([1, 0, 0], xLo)
    const b = a.trimByPlane([-1, 0, 0], -xHi)
    const c = b.trimByPlane([0, 0, 1], zLo)
    const d = c.trimByPlane([0, 0, -1], -zHi)
    const empty = d.isEmpty() || d.volume() <= 1e-9
    const bb = empty ? null : d.boundingBox()
    a.delete(); b.delete(); c.delete(); d.delete()
    return bb
  }
  // Slab half-width 0.05 (not 0.25): the rim climbs at up to drz/dx ≈ 1.3, so
  // a wide slab takes its tip reference from the slab's high end and then
  // measures 0.6 below THAT — reading the edge thinner than it is. A thin slab
  // keeps the reference local. The measurement still cuts a climbing rim
  // obliquely, so it stays conservative against the true perpendicular radius.
  const H = 0.05
  const stations = []
  for (const x of [128, 134, 140, 146, 152, 157]) {
    for (const sz of [1, -1]) {
      const col = slabBounds(x - H, x + H, sz > 0 ? 0 : -40, sz > 0 ? 40 : 0)
      if (!col) continue
      const tipZ = sz > 0 ? col.max[2] : col.min[2]
      const z = tipZ - sz * inboardMm
      const bb = slabBounds(x - H, x + H, Math.min(z, z - sz * 0.06), Math.max(z, z - sz * 0.06))
      if (!bb) { stations.push({ x, side: sz > 0 ? '+z' : '−z', tipZ: +tipZ.toFixed(1), thicknessMm: 0 }); continue }
      stations.push({ x, side: sz > 0 ? '+z' : '−z', tipZ: +tipZ.toFixed(1), thicknessMm: +(bb.max[1] - bb.min[1]).toFixed(3) })
    }
  }
  const worst = stations.reduce((a, s) => (s.thicknessMm < a.thicknessMm ? s : a), stations[0])
  const idealMm = +(2 * Math.sqrt(RIM_R ** 2 - (RIM_R - inboardMm) ** 2)).toFixed(3)
  return {
    ok: worst.thicknessMm >= minThicknessMm,
    rimRadiusMm: RIM_R, inboardMm, idealThicknessMm: idealMm,
    minThicknessMm, worst, stations,
    effectiveEdgeRadiusMm: +((worst.thicknessMm / idealMm) * RIM_R).toFixed(3),
    specFloorMm: 0.6
  }
}

/** Peduncle wall at spec (D7: 1.8). Runs the G2 sampler over the hollow run
 *  ONLY (blade and the spec'd apertures excluded) at the 1.8 floor, so the
 *  "peduncle 1.8" claim is a gate result rather than a comment. */
export function wallProof(part) {
  return G2_minWall(part, {
    samples: 6000,
    minWallMm: WALL.peduncle,
    excludeRegions: [
      { min: [123, -8, -40], max: [161, 8, 40] }, // blade: gated separately at 1.25 + rimProof
      // knuckle and its J2 thrust chamfer: a 3.0 boss with a designed 1.5×45°
      // break at the lower edge, so chords across the break read ~1.74. Not
      // peduncle wall — covered by the whole-part 1.25 sweep, which passes.
      { min: [98, -8, -14], max: [112, 8, 14] },
      ...(part.meta.excludeRegions ?? []) // spec'd flood/vent apertures
    ]
  })
}

// ── digital ±30° proof ────────────────────────────────────────────────────
/** Volumetric swing audit in the local hinge frame: tail yawed γ about the pin
 *  must clear fork + transom for |γ| < 30° and ENGAGE the stops past 30°;
 *  the Ø6.0 pin must clear both bores. */
export function stopCheck() {
  const Manifold = M()
  const forkPart = clevisFork()
  const transom = Manifold.cube([2.3, 38.5, 49], true).translate([-8.15, 0, 0]) // stand-in at x_local −7 (hull section there is 38.5×49)
  const scene = forkPart.manifold.add(transom)
  forkPart.manifold.delete(); transom.delete()
  const tail = tailLocal()

  const interAt = (deg) => {
    const rot = tail.rotate([0, 0, deg])
    const x = rot.intersect(scene)
    const v = x.volume()
    x.delete(); rot.delete()
    return v
  }
  const sweep = []
  let clearOk = true
  for (const g of [0, 10, 20, 29, -10, -20, -29]) {
    const v = interAt(g)
    clearOk &&= v < 0.05
    sweep.push({ deg: g, interMm3: +v.toFixed(3) })
  }
  const engagePlus = interAt(31), engageMinus = interAt(-31)
  const engageOk = engagePlus > 0.5 && engageMinus > 0.5
  let lo = 29, hi = 31
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2
    if (interAt(mid) > 0.02) hi = mid
    else lo = mid
  }
  const contactDeg = +((lo + hi) / 2).toFixed(2)

  const pin = Manifold.cylinder(50, 3.0, 3.0, 96).translate([0, 0, HINGE.pin.shankBotZ])
  const assy = scene.add(tail)
  const pinX = assy.intersect(pin)
  const pinInterMm3 = pinX.volume()
  pinX.delete(); assy.delete(); pin.delete()
  tail.delete(); scene.delete()

  const ok_ = clearOk && engageOk && contactDeg >= 29.5 && contactDeg <= 30.5 && pinInterMm3 < 0.05
  return {
    ok: ok_,
    sweep, clearOk,
    stopsEngage: { at31degMm3: +engagePlus.toFixed(1), atMinus31Mm3: +engageMinus.toFixed(1), ok: engageOk },
    contactDeg,
    pinInterMm3: +pinInterMm3.toFixed(4)
  }
}

// ── self-test ─────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  await boot()
  let allOk = true

  const parts = [tailAssembly(), hingePin(), retainerCap()]
  for (const part of parts) {
    const g1 = G1_manifoldRoundtrip(part)
    const g3 = G3_cavities(part)
    const g4 = G4_plateFit(part)
    if (part.name === 'p3-tail-assembly') {
      const rim = rimProof(part.manifold)
      const wall = wallProof(part)
      const g2 = G2_minWall(part, { samples: 6000 }) // whole part at the 1.25 floor — no blade exclusion
      allOk &&= rim.ok && wall.ok && g2.ok
      console.log(JSON.stringify({ check: 'rimProof-P3-edge-radius', ...rim }))
      console.log(JSON.stringify({
        check: 'wallProof-P3-peduncle-1.8', ok: wall.ok,
        minWallSampledMm: wall.minWallSampledMm, wallSamples: wall.wallSamples,
        violations: wall.violations, worst: wall.worst?.slice(0, 3)
      }))
      console.log(JSON.stringify({
        check: 'G2-P3-whole-part-1.25', ok: g2.ok,
        minWallSampledMm: g2.minWallSampledMm, wallSamples: g2.wallSamples,
        excluded: g2.excluded, violations: g2.violations, worst: g2.worst?.slice(0, 3)
      }))
    }
    const okPart = g1.ok && g3.ok && g4.ok
    allOk &&= okPart
    const bb = part.manifold.boundingBox()
    console.log(JSON.stringify({
      part: part.name, ok: okPart,
      gates: {
        G1: g1.ok, G3: g3.ok, G4: g4.ok,
        genus: g3.genus.value, expectedGenus: part.meta.expectedGenus,
        drainTrappedMm3: g3.drain.trappedMm3,
        footprintMm: g4.footprintMm, heightWithStandoffMm: g4.heightWithStandoffMm
      },
      volCm3: +(part.manifold.volume() / 1000).toFixed(2),
      bounds: [bb.min, bb.max].map((p) => p.map((x) => +x.toFixed(1))),
      ...(part.meta.dryMassG ? { dryMassG: part.meta.dryMassG, floodedSubmergedGf: part.meta.floodedSubmergedGf } : {})
    }))
    part.manifold.delete()
  }

  // fork reference (prints inside P2 — reported + STL'd for the assembly render)
  const fork = clevisFork()
  const fv = fork.manifold.volume() / 1000
  const forkGlobal = fork.manifold.translate([HINGE.axisGlobalX, 0, 0])
  const stl = writeSTL(forkGlobal, new URL('../parts/p2-clevis-fork-REF.stl', import.meta.url).pathname, 'saycad fish clevis fork REF')
  forkGlobal.delete()
  console.log(JSON.stringify({
    part: fork.name, ref: 'unions into P2 — not a standalone print',
    volCm3: +fv.toFixed(2), massG: +(fv * 1.15).toFixed(1),
    genusInfo: fork.manifold.genus(), stops: fork.meta.stops, stl: stl.triangles
  }))
  fork.manifold.delete()

  const stops = stopCheck()
  allOk &&= stops.ok
  console.log(JSON.stringify({ check: 'stopCheck-J2-swing', ...stops }))

  console.log(JSON.stringify({ verdict: allOk ? 'GREEN' : 'RED', module: 'tailparts', plate: PLATE.usable }))
  process.exit(allOk ? 0 : 1)
}
