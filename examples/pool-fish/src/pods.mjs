// pods.mjs — P1 (nose → x=−20) and P2 (x=−20 → +100 + clevis) per spec §2/§4-J1.
// Global frame (api.md): +X longitudinal (nose apex −140), +Z up, sections
// ry = b·s(x), rz = c·s(x), s = √(1−(x/a)²). Pods print open-rim-down (D2):
// P1 print-up = −X (nose up), P2 print-up = +X (clevis up).
//
// J1 seam at x=−20 (the only glued wet seam): 6.5-wide annular flange rings
// (spec 5 — widened +1.5 so witness step / socket+nub ring / mid glue groove /
// inner moat all sit on separated lands), 3× 0.2 standoff nubs, groove 1.0×0.5
// at mid-flange, moat 1.0×0.5 flush to the inner edge, 0.4 witness step at the
// outer edge, 3× Ø3.3×4.5 pin sockets in a rotationally-asymmetric,
// non-mirrorable pattern (mis-assembly geometrically impossible).
import { boot, M, loft, writeSTL } from '../lib.mjs'
import { ENVELOPE, CUTS, FIT, PLATE, WALL } from './machine.mjs'
import { threadFemaleCutter, THREAD } from './threads.mjs'
import { clevisFork, HINGE } from './tailparts.mjs'
import { G1_manifoldRoundtrip, G3_cavities, G4_plateFit } from './gates.mjs'

const { a, b, c } = ENVELOPE
const scaleAt = (x) => Math.sqrt(Math.max(0, 1 - (x / a) ** 2))
const ryAt = (x) => b * scaleAt(x)
const rzAt = (x) => c * scaleAt(x)
/** wall inset with nose taper compensation (§5 shell.js: longitudinal-taper
 *  thinning near the nose is real — G2-measured at 1.2–1.9 with a weak ramp,
 *  so the inset grows quadratically toward the apex to hold ≥2.0 normal) */
const insetAt = (x) => WALL.hull + (Math.abs(x) > 95 ? 1.35 * ((Math.abs(x) - 95) / 45) ** 2 : 0)

// Feature-belt layout (REAL mm — the socket is a Ø3.3 CIRCLE, so it spans
// ±1.65 in EVERY direction from its center circle, audit finding): witness
// 0–0.4 · web land 0.6–1.15 · socket/nub circle at 3.05 (sockets reach
// 1.40–4.70) · groove 5.0–6.0 (interrupted at the 3 socket angles) · moat
// 6.45–7.45 flush to the inner edge. Flange widened 5 → 7.6: a Ø3.3 socket +
// groove + moat cannot coexist in the spec's 5 (documented deviation).
const SEAM = {
  x: CUTS.p1p2, // −20
  flangeW: 7.6, ringThk: 6.75, // ring depth 6.75 → 2.25 floor behind the 4.5 sockets (G2)
  witness: [0, 0.4], // outer-edge step (≈ the 0.4×45° witness chamfer)
  webLand: [0.6, 1.15], // face annulus the break-away skirt web grips
  ringR: 3.05, // socket + nub circle inset
  groove: [5.0, 6.0], // 1.0 × 0.5 glue groove (P1 face only, bridged at socket angles)
  moat: [6.45, 7.45], // 1.0 × 0.5 squeeze-out moat flush to the inner edge (P1 face only)
  nubPhiDeg: [90, 210, 330], nubH: 0.2, nubR: 1.0,
  socketPhiDeg: [60, 165, 300], socketR: (3.0 + 2 * FIT.pinSocketRadial) / 2, socketDepth: 4.5,
  pinLen: 8.5 // production J1 pin: 4.25 per side + 0.2 nub gap ⇒ 8.7 max, cut to 8.5
}
// Seam diaphragm: the flange annulus leaves an open central hole, so without
// this wall F2+M1 would be ONE ~264 cm³ compartment whose flood sinks the fish
// (audit finding). A 2.0 wall just behind the P1 ring restores the four-
// chamber flood ledger; its Ø4 drain takes a P6 plug at assembly step 3.
const DIAPHRAGM = { x: -27.9, thk: 2.0 } // spans x −28.9…−26.9
const PORTS = { p1x: -50, p2x: 10, faceR: 16.5, neckR: 13.15 } // M20 belly ports over the trays
const TRAYS = { tabAtX: { p1: [-74, -70], p2: [30, 34] }, bulkGCm3: 1.8 } // witness-tab z is SOLVED from the ballast target (audit: a fixed z=−8 encoded ~170 g)
const BULKHEADS = { p1x: -80, p2x: 40, thk: 2, drainR: 2.0 } // Ø4.0 drains (J5 plugs)
const VENTS = { p1x: -125, p2x: 95, r: 1.5 } // Ø3.0 shell vents (UV-resin sealed at step 7)
const FINS = { dorsalX: -60, boreR: (6.0 + 2 * FIT.finTangRadial) / 2, dorsalDepth: 12, pectoralDepth: 10, bossR: 6.15, drainR: 1.0 }

function ok(m, what) {
  const s = String(m.status()?.value ?? m.status())
  if (s !== '0' && s !== 'NoError') throw new Error(`${what}: manifold status ${s}`)
  return m
}

/** elliptical cylinder along +X: x ∈ [x0, x0+len], y-radius ry, z-radius rz */
function ellipCyl(x0, len, ry, rz, segs = 96) {
  return M().cylinder(len, 1, 1, segs).scale([rz, ry, 1]).rotate([0, 90, 0]).translate([x0, 0, 0])
}
/** elliptical ring (annulus) along +X, axes inset iOut → iIn from (ryRef, rzRef) */
function ellipRing(x0, len, ryRef, rzRef, iOut, iIn, segs = 96) {
  const big = ellipCyl(x0, len, ryRef - iOut, rzRef - iOut, segs)
  const small = ellipCyl(x0 - 1, len + 2, ryRef - iIn, rzRef - iIn, segs)
  const ring = ok(big.subtract(small), 'ellipRing')
  big.delete(); small.delete()
  return ring
}

// ── hull shell (outer loft − taper-compensated inner loft) ────────────────
const OUTER_X = [-139.3, -134, -126, -115, -100, -82, -62, -40, -20, 0, 20, 40, 60, 78, 90, 97, 100]
// inner apex sits 4.1 mm behind the outer apex: the nose cone is so steep that
// no radial inset holds 2.0 normal there — the tip prints as a solid nose cap
const INNER_X = [-134.7, -130.8, -125, -114, -100, -82, -62, -40, -20, 0, 20, 40, 60, 78, 90, 95, 97.75]

function ringYZ(x, ry, rz, n = 96) {
  const ring = []
  for (let j = 0; j < n; j++) {
    const t = (2 * Math.PI * j) / n
    ring.push([x, ry * Math.cos(t), rz * Math.sin(t)])
  }
  return ring
}
function loftX(rings) {
  const attempt = (rs) => {
    const m = loft(rs)
    if (m.volume() <= 0) { m.delete(); throw new Error('inverted') }
    return m
  }
  try { return attempt(rings) } catch { return attempt(rings.map((r) => [...r].reverse())) }
}

function buildShell() {
  const outer = loftX(OUTER_X.map((x) => ringYZ(x, ryAt(x), rzAt(x))))
  const inner = loftX(INNER_X.map((x) => {
    const i = insetAt(x)
    return ringYZ(x, Math.max(ryAt(x) - i, 0.3), Math.max(rzAt(x) - i, 0.3))
  }))
  const shell = ok(outer.subtract(inner), 'hull shell')
  inner.delete()
  return { outer, shell } // outer is kept for chamber accounting
}

// ── J1 seam features ──────────────────────────────────────────────────────
const seamRy = ryAt(SEAM.x), seamRz = rzAt(SEAM.x)
/** point on the ellipse inset i at parametric angle φ (degrees) */
const seamPt = (phiDeg, i) => {
  const t = (phiDeg * Math.PI) / 180
  return [(seamRy - i) * Math.cos(t), (seamRz - i) * Math.sin(t)]
}

function flangeRing(side /* 'p1' | 'p2' */) {
  const x0 = side === 'p1' ? SEAM.x - SEAM.ringThk : SEAM.x
  return ellipRing(x0, SEAM.ringThk, seamRy, seamRz, 0, SEAM.flangeW)
}
function seamCutsShared(forSide /* 'p1' | 'p2' */) {
  const cuts = []
  cuts.push(ellipRing(SEAM.x - 0.4, 0.8, seamRy, seamRz, -0.5, SEAM.witness[1])) // witness step at the outer rim edge
  for (const phi of SEAM.socketPhiDeg) { // sockets at identical (y,z) in both faces
    const [y, z] = seamPt(phi, SEAM.ringR)
    const x0 = forSide === 'p1' ? SEAM.x - SEAM.socketDepth : SEAM.x - 0.1
    cuts.push(M().cylinder(SEAM.socketDepth + 0.1, SEAM.socketR, SEAM.socketR, 64)
      .rotate([0, 90, 0]).translate([x0, y, z]))
  }
  return cuts
}
function p1FaceCuts() { // glue groove + squeeze-out moat live on the P1 face only
  // cutters run 0.2 PAST the face plane — an open 0.5-deep groove, never a
  // skinned-over (print-sealed) subsurface torus. Both rings are BRIDGED at
  // the three socket angles (blocker boxes) so no thin land forms between a
  // socket bore and a groove wall; G/flex spreads across 3 short bridges fine.
  const cuts = []
  for (const band of [SEAM.groove, SEAM.moat]) {
    let ring = ellipRing(SEAM.x - 0.5, 0.7, seamRy, seamRz, band[0], band[1])
    for (const phi of SEAM.socketPhiDeg) {
      const [y, z] = seamPt(phi, SEAM.ringR)
      const blocker = M().cube([1.4, 9, 9], true).translate([SEAM.x - 0.15, y, z])
      const next = ok(ring.subtract(blocker), 'groove bridge')
      ring.delete(); blocker.delete()
      ring = next
    }
    cuts.push(ring)
  }
  return cuts
}
function seamDiaphragm() {
  const i = insetAt(DIAPHRAGM.x)
  return ellipCyl(DIAPHRAGM.x - DIAPHRAGM.thk / 2, DIAPHRAGM.thk,
    ryAt(DIAPHRAGM.x) - i + 0.75, rzAt(DIAPHRAGM.x) - i + 0.75)
}
function diaphragmDrain() {
  const zLow = -(rzAt(DIAPHRAGM.x) - insetAt(DIAPHRAGM.x)) + 2.5
  return M().cylinder(DIAPHRAGM.thk + 3, BULKHEADS.drainR, BULKHEADS.drainR, 48)
    .rotate([0, 90, 0]).translate([DIAPHRAGM.x - DIAPHRAGM.thk / 2 - 1.5, 0, zLow])
}
function seamNubs() {
  return SEAM.nubPhiDeg.map((phi) => {
    const [y, z] = seamPt(phi, SEAM.ringR)
    return M().cylinder(SEAM.nubH, SEAM.nubR, SEAM.nubR, 32).rotate([0, 90, 0]).translate([SEAM.x, y, z])
  })
}
/** break-away skirt: 2×1 perimeter ring on a 0.3 web. The web grips the face
 *  annulus at inset 0.5–1.05 (the witness step removed the outer 0.4, and the
 *  skirt hangs on the pod's PLATE side, which differs per pod). */
function skirtFor(side) {
  const sgn = side === 'p1' ? -1 : 1 // P1 plate side is +x of the rim; P2 plate side is −x
  const webX0 = side === 'p1' ? SEAM.x - 0.1 : SEAM.x - 0.3
  const ringX0 = side === 'p1' ? SEAM.x + 0.3 : SEAM.x - 1.3
  const web = ellipRing(webX0, 0.4, seamRy, seamRz, SEAM.webLand[0], SEAM.webLand[1])
  const ring = ellipRing(ringX0, 1.0, seamRy, seamRz, -0.5, 1.5)
  const skirt = ok(ring.add(web), `skirt-${side}-${sgn}`)
  ring.delete(); web.delete()
  return skirt
}

// ── belly port boss (two-tier pad + neck; thread cutter pierces the top) ──
function portBoss(x, faceZ) {
  const disc = M().cylinder(2.7, PORTS.faceR, PORTS.faceR, 96).translate([x, 0, faceZ])
  const neckTop = faceZ + THREAD.engagementMm - 0.3 // cutter (7.5) pokes 0.3 past the neck — port opens into the tray
  const neck = M().cylinder(neckTop - (faceZ + 2.7), PORTS.neckR, PORTS.neckR, 96).translate([x, 0, faceZ + 2.7])
  const boss = ok(disc.add(neck), 'portBoss')
  disc.delete(); neck.delete()
  return boss
}
function portCutter(x, faceZ) {
  const cut = threadFemaleCutter(THREAD.engagementMm)
  const placed = cut.manifold.translate([x, 0, faceZ])
  cut.manifold.delete()
  return placed
}

// ── bulkheads / vents / tray tabs / fin sockets ───────────────────────────
function bulkhead(x) {
  const i = insetAt(x)
  return ellipCyl(x - BULKHEADS.thk / 2, BULKHEADS.thk, ryAt(x) - i + 0.75, rzAt(x) - i + 0.75)
}
function bulkheadDrain(x) {
  const zLow = -(rzAt(x) - insetAt(x)) + 2.5
  return M().cylinder(BULKHEADS.thk + 3, BULKHEADS.drainR, BULKHEADS.drainR, 48)
    .rotate([0, 90, 0]).translate([x - BULKHEADS.thk / 2 - 1.5, 0, zLow])
}
function shellVent(x) {
  const zOut = -rzAt(x)
  return M().cylinder(7, VENTS.r, VENTS.r, 48).translate([x, 0, zOut - 1.5])
}
function trayTabs(xs, fillZ) {
  const tabs = []
  const boxes = [] // G2 exclude boxes (1.5 mm witness ledges are by-design thin)
  for (const x of xs) {
    const ryI = ryAt(x) - insetAt(x), rzI = rzAt(x) - insetAt(x)
    const yIn = ryI * Math.sqrt(Math.max(0, 1 - (fillZ / rzI) ** 2))
    // tab center at yIn−0.75 buries ~0.5 of the 2.5-wide tab in the wall
    // (audit: at yIn−1.2 the weld was a ≤0.2 tangent sliver)
    for (const sy of [1, -1]) {
      tabs.push(M().cube([8, 2.5, 1.5], true).translate([x, sy * (yIn - 0.75), fillZ]))
      const yc = sy * (yIn - 0.75)
      boxes.push({ min: [x - 4.2, yc - 1.3, fillZ - 0.9], max: [x + 4.2, yc + 1.3, fillZ + 0.9] })
    }
  }
  return { tabs, boxes }
}
/** dorsal socket (P1): vertical Ø6.3×12 blind + boss + print-frame-tangent Ø2 drain */
function dorsalFeatures() {
  const x = FINS.dorsalX
  const zTop = rzAt(x)
  const boss = M().cylinder(12.6, FINS.bossR, FINS.bossR, 64).translate([x, 0, 17.0]) // floor 2.6 under the bore (G2)
  const bore = M().cylinder(FINS.dorsalDepth + 0.4, FINS.boreR, FINS.boreR, 64).translate([x, 0, zTop - FINS.dorsalDepth])
  // drain offset +X (tangent to the bore's low side in P1's nose-up print frame) so nothing pools (G3)
  const drain = M().cylinder(5.0, FINS.drainR, FINS.drainR, 48).translate([x + (FINS.boreR - FINS.drainR), 0, 16.5])
  return { boss, cuts: [bore, drain] }
}
/** pectoral sockets (P2): Ø6.3×10 blind, axis 25° below horizontal, ×2 */
function pectoralFeatures() {
  const x = 5, tilt = 65 // rotate([±65,0,0]) maps +Z → (0, ∓0.906, +0.423) = inward-up
  const out = []
  for (const sy of [1, -1]) {
    const rot = [sy * tilt, 0, 0]
    const A = [x, sy * 27, -17.2]
    const boss = M().cylinder(14.5, FINS.bossR, FINS.bossR, 64).rotate(rot) // floor 2.7 past the bore (G2)
      .translate([A[0], A[1] - sy * 0.9063 * 3.2, A[2] + 0.4226 * 3.2])
    const bore = M().cylinder(15, FINS.boreR, FINS.boreR, 64).rotate(rot).translate(A)
    const drain = M().cylinder(8, FINS.drainR, FINS.drainR, 48).rotate(rot)
      .translate([A[0] - 2.15, A[1] - sy * 0.9063 * 13, A[2] + 0.4226 * 13]) // tangent-low in P2's +X-up print frame
    out.push({ boss, cuts: [bore, drain] })
  }
  return out
}

const unionAll = (ms) => {
  let acc = ms[0]
  for (let i = 1; i < ms.length; i++) {
    const nxt = acc.add(ms[i])
    acc.delete(); ms[i].delete()
    acc = nxt
  }
  return acc
}
const subtractAll = (base, cuts) => {
  let acc = base
  for (const cut of cuts) {
    const nxt = ok(acc.subtract(cut), 'subtract')
    acc.delete(); cut.delete()
    acc = nxt
  }
  return acc
}

// ── the pods ──────────────────────────────────────────────────────────────
export function buildPods({ skirts = true, ballastTargetG = 120 } = {}) {
  const { outer, shell } = buildShell()

  // P1: nose pod (tabs are unioned AFTER the tray-fill solve below)
  const p1Shell = shell.trimByPlane([-1, 0, 0], -SEAM.x) // keep x ≤ −20
  const dorsal = dorsalFeatures()
  let p1 = unionAll([
    p1Shell, flangeRing('p1'), ...seamNubs(), bulkhead(BULKHEADS.p1x),
    seamDiaphragm(), dorsal.boss, portBoss(PORTS.p1x, -34.2)
  ])
  p1 = subtractAll(p1, [
    ...seamCutsShared('p1'),
    ...p1FaceCuts(),
    bulkheadDrain(BULKHEADS.p1x),
    diaphragmDrain(),
    shellVent(VENTS.p1x),
    portCutter(PORTS.p1x, -34.2),
    ...dorsal.cuts
  ])

  // P2: rear pod + clevis
  const p2Shell = shell.trimByPlane([1, 0, 0], SEAM.x) // keep x ≥ −20
  shell.delete()
  const fork = clevisFork()
  const forkPlaced = fork.manifold.translate(fork.meta.unionAt)
  fork.manifold.delete()
  const pect = pectoralFeatures()
  let p2 = unionAll([
    p2Shell, flangeRing('p2'), bulkhead(BULKHEADS.p2x), forkPlaced,
    ...pect.map((p) => p.boss), portBoss(PORTS.p2x, -35.2)
  ])
  p2 = subtractAll(p2, [
    ...seamCutsShared('p2'),
    bulkheadDrain(BULKHEADS.p2x),
    shellVent(VENTS.p2x),
    portCutter(PORTS.p2x, -35.2),
    ...pect.flatMap((p) => p.cuts)
  ])

  // chamber accounting: chamber = (outer envelope slab) − (part material slab),
  // optionally clipped below a fill plane (for the ballast solve)
  const slabVol = (m, lo, hi, belowZ = null) => {
    const t1 = m.trimByPlane([1, 0, 0], lo)
    const t2 = t1.trimByPlane([-1, 0, 0], -hi)
    let v
    if (belowZ === null) v = t2.volume()
    else {
      const t3 = t2.trimByPlane([0, 0, -1], -belowZ)
      v = t3.volume()
      t3.delete()
    }
    t1.delete(); t2.delete()
    return v
  }
  const chamberRaw = (part, lo, hi, belowZ = null) => (slabVol(outer, lo, hi, belowZ) - slabVol(part, lo, hi, belowZ)) / 1000
  // sealed chambers (voids incl. future ballast): the seam pocket between the
  // diaphragm and the flange hole belongs to the JOINT mid chamber with M1
  const dLo = DIAPHRAGM.x - DIAPHRAGM.thk / 2, dHi = DIAPHRAGM.x + DIAPHRAGM.thk / 2
  const chambers = {
    F1: +chamberRaw(p1, -139.3, BULKHEADS.p1x - 1).toFixed(1),
    F2: +chamberRaw(p1, BULKHEADS.p1x + 1, dLo - 0.1).toFixed(1),
    M1joint: +(chamberRaw(p1, dHi + 0.1, SEAM.x) + chamberRaw(p2, SEAM.x, BULKHEADS.p2x - 1)).toFixed(1),
    M2: +chamberRaw(p2, BULKHEADS.p2x + 1, 100).toFixed(1)
  }

  // ballast witness tabs: solve the fill plane where the pebble/epoxy bed
  // (bulk 1.8 g/cm³) in BOTH trays reaches the target mass; the aft tray is
  // the joint chamber's belly (pebbles cross the flange hole — its lower lip
  // sits at z≈−27, far below any plausible fill line)
  const trayVolAt = (z) =>
    chamberRaw(p1, BULKHEADS.p1x + 1, dLo - 0.1, z) +
    chamberRaw(p1, dHi + 0.1, SEAM.x, z) +
    chamberRaw(p2, SEAM.x, BULKHEADS.p2x - 1, z)
  let lo = -33, hi = 0
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (trayVolAt(mid) * TRAYS.bulkGCm3 < ballastTargetG) lo = mid
    else hi = mid
  }
  const fillZ = +((lo + hi) / 2).toFixed(1)
  const tabG = +(trayVolAt(fillZ) * TRAYS.bulkGCm3).toFixed(1)
  // bed centroid: z of the half-full slab ≈ midpoint of floor(−31.5) and fill
  const bedCentroidZ = +((fillZ + -31.3) / 2).toFixed(1)
  const trayFill = { fillZ, tabImpliedG: tabG, targetG: ballastTargetG, bedCentroidZ, bulkGCm3: TRAYS.bulkGCm3 }

  const p1Tabs = trayTabs(TRAYS.tabAtX.p1, fillZ)
  const p2Tabs = trayTabs(TRAYS.tabAtX.p2, fillZ)
  {
    const merged = ok(unionAll([p1, ...p1Tabs.tabs]), 'p1+tabs')
    p1 = merged
    const merged2 = ok(unionAll([p2, ...p2Tabs.tabs]), 'p2+tabs')
    p2 = merged2
  }
  // keep bare (skirt-less) handles: the skirts are sacrificial and snap off
  // before assembly — mate probes must run against the bare pods
  const bare = { p1, p2 }
  if (skirts) {
    const p1Skirt = skirtFor('p1')
    p1 = ok(p1.add(p1Skirt), 'p1+skirt')
    p1Skirt.delete()
    const p2Skirt = skirtFor('p2')
    p2 = ok(p2.add(p2Skirt), 'p2+skirt')
    p2Skirt.delete()
  }

  const sealedSolid = outer // outer loft (ends at the transom) — the real displacement body
  return { p1: wrapP1(p1, chambers, p1Tabs.boxes, trayFill), p2: wrapP2(p2, chambers, p2Tabs.boxes, trayFill), bare, chambers, trayFill, sealedSolid }
}

/** shared G2 region math: the seam feature belt is excluded from the 2.0 floor
 *  — its lands are deterministic by construction (socket outer land 1.65,
 *  P1 socket↔groove land 0.65, socket floors 2.25) and the whole belt is a
 *  glue-flooded, flange-backed (≥6.5) J1 zone; skirt + web are sacrificial. */
const G2_BELT_P1 = { min: [-27.0, -40, -40], max: [-18.4, 40, 40] }
const G2_BELT_P2 = { min: [-21.5, -40, -40], max: [-13.0, 40, 40] }

function wrapP1(manifold, chambers, tabBoxes, trayFill) {
  return {
    name: 'p1-front-hull-pod',
    manifold,
    printOrientation: { up: [-1, 0, 0], note: 'open rim down on the skirt + 5–6 mm standoffs; nose up; keep nubs and both faces support-free' },
    meta: {
      qty: 1,
      expectedGenus: 4, // measured & pinned — regression tripwire; the enforced safety invariant is genus ≥ 0 + drain sealedAir = 0
      excludeRegions: [G2_BELT_P1, ...tabBoxes,
        { min: [-60.5, -10.5, -34.4], max: [-39.5, 10.5, -26.4] }, // female port-thread ridges (r ≤10.5 inside the 13.15 neck; ridge chords 1.2–1.9 are the ISO profile, not walls — neck outer wall stays audited)
        { min: [-128, -3, -18], max: [-122, 3, -11] }], // Ø3 belly-vent rim wedge (hole-rim chords are the spec'd opening, not walls)
      g2Note: 'seam feature belt + 1.5 mm tray witness tabs + port thread bore excluded from the 2.0 floor by design; boss WALLS are 3.0 by construction via WALL.boss (socket floors 2.6–2.7) — no bossRegions AABBs (they would false-flag the adjacent 2.25 shell)',
      genusNote: 'rim primary; +1 each: belly vent, M20 port, dorsal-socket drain, Ø4 bulkhead pass-through, Ø4 seam-diaphragm pass-through — zero print-sealed cavities (drain audit sealedAir = 0); ~4 mm³ pooled in the horizontal port-thread roots, syringe-flushed at step 4',
      minWallMm: WALL.hullFloor,
      chambersCm3: { F1: chambers.F1, F2: chambers.F2 },
      trayFill,
      fits: [
        { joint: 'J1', name: 'pin sockets Ø3.3×4.5 (×3, asymmetric)', perSideMm: FIT.pinSocketRadial, kind: 'radial' },
        { joint: 'J1', name: 'standoff nubs 0.2 (×3)', perSideMm: FIT.bondlineNub, kind: 'axial', note: 'bondline control' },
        { joint: 'J3', name: 'M20×2.5 belly port (female)', perSideMm: FIT.threadFemaleRadial, kind: 'radial' },
        { joint: 'J4', name: 'dorsal fin socket Ø6.3×12', perSideMm: FIT.finTangRadial, kind: 'radial' },
        { joint: 'J5', name: 'bulkhead drain Ø4.0', perSideMm: 0.05, kind: 'radial', note: 'tapered P6 plug, UV-resin bedded (spec §4 J5)' }
      ],
      sealNote: 'Ø3.0 belly vent (x=−125) sealed at step 7 with UV-resin fill + epoxy skim (J5 method); Ø4 bulkhead drain AND Ø4 seam-diaphragm drain each take a P6 plug (3 used fish-wide)',
      trayNote: `fore pebble/epoxy tray −80…−29; fill to the witness tabs at z=${trayFill.fillZ} (both trays together ≈ ${trayFill.tabImpliedG} g at bed centroid z≈${trayFill.bedCentroidZ})`,
      deviationNote: 'seam diaphragm added at x=−27.9 (spec had none): without it F2+M1 form one ~264 cm³ compartment through the open flange hole and a single flood sinks the fish — the diaphragm restores the spec §3 four-chamber flood ledger; flange 5→7.6 wide (Ø3.3 sockets + groove + moat cannot coexist in 5)'
    }
  }
}
function wrapP2(manifold, chambers, tabBoxes, trayFill) {
  return {
    name: 'p2-rear-hull-pod',
    manifold,
    printOrientation: { up: [1, 0, 0], note: 'open rim down on the skirt + 5–6 mm standoffs; clevis up; keep rim face and gland-side boss face support-free' },
    meta: {
      qty: 1,
      expectedGenus: 8, // measured & pinned — regression tripwire; the enforced safety invariant is genus ≥ 0 + drain sealedAir = 0
      excludeRegions: [G2_BELT_P2, ...tabBoxes,
        { min: [-0.5, -10.5, -35.4], max: [20.5, 10.5, -27.4] }, // female port-thread ridges (see P1 note)
        { min: [92, -3, -28], max: [98, 3, -19] }], // Ø3 shell-vent rim wedge
      g2Note: 'seam feature belt + tray witness tabs + port thread bore excluded from the 2.0 floor by design; boss WALLS are 3.0 by construction via WALL.boss (socket floors 2.6–2.7); fork stop columns are 2.8 thick (≥2.0 floor applies)',
      genusNote: 'rim primary; +1 each: shell vent, M20 port, 2× pectoral drains, Ø4 bulkhead pass-through; +3 clevis fork (2 bored bands + column loop); +1 flange-ring annular weld; +1 skirt (solid torus) — zero print-sealed cavities; ~5 mm³ pooled in the horizontal port-thread roots is real and syringe-flushed at step 4',
      minWallMm: WALL.hullFloor,
      chambersCm3: { M1joint: chambers.M1joint, M2: chambers.M2 },
      trayFill,
      fits: [
        { joint: 'J1', name: 'pin sockets Ø3.3×4.5 (×3, asymmetric)', perSideMm: FIT.pinSocketRadial, kind: 'radial' },
        { joint: 'J2', name: 'clevis bores Ø6.5 (×2)', perSideMm: FIT.hingeRadial, kind: 'radial' },
        { joint: 'J3', name: 'M20×2.5 belly port (female)', perSideMm: FIT.threadFemaleRadial, kind: 'radial' },
        { joint: 'J4', name: 'pectoral fin sockets Ø6.3×10 (×2)', perSideMm: FIT.finTangRadial, kind: 'radial' },
        { joint: 'J5', name: 'bulkhead drain Ø4.0', perSideMm: 0.05, kind: 'radial', note: 'tapered P6 plug, UV-resin bedded (spec §4 J5)' }
      ],
      sealNote: 'Ø3.0 shell vent (x=+95) sealed at step 7 with UV-resin fill + epoxy skim; Ø4 bulkhead drain takes a P6 plug',
      trayNote: `aft pebble/epoxy tray (joint chamber belly, −27…+39 incl. the seam pocket); fill to the witness tabs at z=${trayFill.fillZ}`,
      deviationNote: 'flange widened 5→7.6 for real feature-land separation (audit); pectoral sockets 12 deep vs spec 10 — 2 mm glue pocket under the 10 mm tang; print height ~143 incl. skirt+standoff (≤145 usable — confirm Mono-class machine, HARD GATE)'
    }
  }
}

/** assembly-position probe coordinates for integrate.mjs's measured mate
 *  checks (audit: G5 walks declared tables — these drive booleans against the
 *  ACTUAL pod geometry) */
export const PROBES = {
  seamX: SEAM.x, socketDepth: SEAM.socketDepth,
  j1: SEAM.socketPhiDeg.map((phi) => { const [y, z] = seamPt(phi, SEAM.ringR); return { y: +y.toFixed(2), z: +z.toFixed(2) } }),
  dorsal: { x: FINS.dorsalX, boreR: FINS.boreR, boreTopZ: +rzAt(FINS.dorsalX).toFixed(2), depth: FINS.dorsalDepth },
  port1: { x: PORTS.p1x, faceZ: -34.2 }
}

/** production J1 registration pin (coupon P8 pins are 12 long — test only) */
export function seamPin() {
  const manifold = ok(M().cylinder(SEAM.pinLen, 1.5, 1.5, 64), 'seamPin')
  return {
    name: 'j1-seam-pin',
    manifold,
    printOrientation: { up: [0, 0, 1], note: 'vertical on a small raft tab' },
    meta: {
      qty: 5, // 3 + 2 spares
      expectedGenus: 0,
      fits: [{ joint: 'J1', name: 'Ø3.0 pin in Ø3.3 sockets', perSideMm: FIT.pinSocketRadial, kind: 'radial', note: '8.5 long: 4.25 per side + 0.2 nub gap' }]
    }
  }
}

// ── self-test ─────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  await boot()
  const t0 = Date.now()
  const { p1, p2, chambers, trayFill, sealedSolid } = buildPods()
  const pin = seamPin()
  let allOk = true

  const specChambers = { F1: 80, F2: 79, M1: 112, M2: 111 } // §3 estimates — mesh supersedes (M1joint = M1 + the seam pocket behind the new diaphragm)
  for (const part of [p1, p2, pin]) {
    const g1 = G1_manifoldRoundtrip(part)
    const g3 = G3_cavities(part)
    const g4 = G4_plateFit(part)
    const okPart = g1.ok && g3.ok && g4.ok
    allOk &&= okPart
    console.log(JSON.stringify({
      part: part.name, ok: okPart,
      gates: {
        G1: g1.ok, G3: g3.ok, G4: g4.ok,
        genus: g3.genus.value, expectedGenus: part.meta.expectedGenus,
        drainTrappedMm3: g3.drain.trappedMm3, drainWorst: g3.drain.worst.slice(0, 2),
        footprintMm: g4.footprintMm, heightWithStandoffMm: g4.heightWithStandoffMm
      },
      volCm3: +(part.manifold.volume() / 1000).toFixed(1),
      massG: +((part.manifold.volume() / 1000) * 1.15).toFixed(1)
    }))
  }

  const sealedCm3 = +(Object.values(chambers).reduce((s, v) => s + v, 0)).toFixed(1)
  // flood-floats limit (the physics behind the spec's ≤~115 estimate): worst
  // single flooded chamber adds V·ρw to the 323 g all-up; require draft frac
  // x ≤ 0.80 → V_disp = x²(3−2x) = 0.896 → 564.4·0.896·0.997 − 323 = 181 cm³.
  // Bulkheads at spec x=−80/+40 + the seam diaphragm; mesh supersedes §3.
  const floodLimitCm3 = 181
  const worstFlood = Math.max(...Object.values(chambers))
  const worstDraftFrac = (() => { // solve x²(3−2x) = (323+V)/562.7 by bisection
    const target = (323 + worstFlood * 0.997) / 562.7
    let lo = 0, hi = 1
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; (m * m * (3 - 2 * m) < target ? lo = m : hi = m) }
    return +((lo + hi) / 2).toFixed(3)
  })()
  const chambersOk = sealedCm3 >= 382 && worstFlood <= floodLimitCm3
  allOk &&= chambersOk
  console.log(JSON.stringify({
    check: 'chambers-G6-precheck', ok: chambersOk,
    chambersCm3: chambers, specEstimate: specChambers,
    sealedVoidCm3: sealedCm3, requiredCm3: 382,
    floodLimitCm3, worstFloodCm3: worstFlood, worstFloodDraftFrac: worstDraftFrac,
    trayFill,
    note: 'chambers = sealed VOID incl. future ballast bed (flood gate is conservative: a ballast-chamber flood ingests only the air fraction)'
  }))
  console.log(JSON.stringify({
    check: 'displacement-body',
    outerLoftCm3: +(sealedSolid.volume() / 1000).toFixed(1),
    note: 'outer loft nose→transom; envelope ellipsoid (564.4 incl. the free-flooding tail span) is the §3 hydro contract'
  }))

  sealedSolid.delete()
  for (const part of [p1, p2, pin]) part.manifold.delete()
  console.log(JSON.stringify({ verdict: allOk ? 'GREEN' : 'RED', module: 'pods', secs: +((Date.now() - t0) / 1000).toFixed(1), plate: PLATE.usable }))
  process.exit(allOk ? 0 : 1)
}
