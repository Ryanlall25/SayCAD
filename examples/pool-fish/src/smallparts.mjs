// smallparts.mjs — P5 ballast plug, P6 tapered drain plugs, P7 fins, and the
// P8 coupon plate (spec §2 rows P5–P8, joints J3–J6). All four are loose parts
// built directly in their print frames (+Z = build up); printOrientation
// metadata declares intent per api.md. Every number that lives in machine.mjs
// is IMPORTED (FIT/PLATE/RHO/WALL); remaining literals are spec §2/§4 values
// kept in exported tables so gates.mjs can walk them.
import { boot, writeSTL, validate, M, CS } from '../lib.mjs'
import { FIT, PLATE, RHO, WALL } from './machine.mjs'
import { THREAD, threadMale, threadFemaleCutter, leadInFadeMm } from './threads.mjs'
import { readFileSync, mkdirSync } from 'node:fs'

// ── spec-literal tables (values NOT present in machine.mjs) ───────────────
export const P5 = {
  gripD: 30, // Ø30 knurled grip (spec P5)
  gripH: 6, // knob height; shoulder face at z = gripH
  knurlTeeth: 24, knurlValleyR: 14.35, // polygonal knurl ≈ 24-tooth star, 0.65 deep
  faceBandH: 1.6, // smooth full-Ø30 band under the shoulder face (clean gland walls)
  threadSinkMm: 0.12, // thread former sunk into the shoulder for a robust union — kept BELOW FIT.threadFemaleRadial (0.15) so the sunk male's lead-in cone never out-reaches the female's fade relief (sink − radial = crest interference if positive)
  gland: { depth: 1.5, width: 2.7, idMm: 22.0 }, // J3: face gland 1.5 × 2.7 at ID 22 (spec band 21–22; 22 keeps the seal band clear of the port's Ø21.3 countersink mouth)
  oring: 'EPDM 21x2 (alt 22x2); squeeze (2.0-1.5)/2.0 = 25% at shoulder contact; stretch onto Ø22.0 wall ~4.8% (<=5%)',
  qty: 3 // 2 + 1 spare
}
export const P6 = {
  bodyD: 3.9, bodyLen: 4.5, flangeD: 6, flangeH: 1.5, // Ø3.9 body, Ø6×1.5 flange (J5)
  holeD: 4.0, // mates Ø4.0 bulkhead drain (pods.mjs side)
  qty: 8 // 4 + 4 spares
}
export const P7 = {
  tangD: 6.0, // Ø6.0 tang → Ø6.3 socket (J4, FIT.finTangRadial)
  dorsal: { L: 50, H: 30, tangLen: 12, qty: 1 },
  pectoral: { L: 35, H: 20, tangLen: 10, qty: 2 } // symmetric section — same STL both sides
}
export const P8 = {
  pinD: 3.0, pinLen: 12, socketDepth: 4.5, drainD: 2.0, // Row A (J1 registration)
  lugThk: 8, lugW: 13, lugTop: 18, boreZ: 10, // Row B (J2 clevis) — bore axes HORIZONTAL
  hingePinD: 6.0,
  cubeMm: 21.5, // 10 mL density cube (21.5³ = 9.94 cm³)
  // socket/bore class diameters DERIVED from the machine fit table:
  rowAClassesMm: [-0.1, 0, 0.1].map((d) => +(3.0 + 2 * FIT.pinSocketRadial + d).toFixed(2)), // 3.2/3.3/3.4
  rowBClassesMm: [-0.2, 0, 0.2].map((d) => +(6.0 + 2 * FIT.hingeRadial + d).toFixed(2)) // 6.3/6.5/6.7
}
// One-build-plate layout for the P8 set (plate + loose ring/cube/pins).
export const LAYOUT8 = {
  slab: [116, 30, 3],
  rowACenters: [[8, 15], [18, 15], [28, 15]], // socket axes VERTICAL = production J1 sockets in upright pods
  rowBLugX0: [36, 54, 72], // lugs 13 wide, bores along Y (horizontal) = production clevis in upright P2
  stub: [102, 15], // M20 male stub center; Ø30 ring runs down clear of all features
  panel: { x0: 40, y0: 24, len: 36, h: 15 }, // 2.25 wall coupon (WALL.hull)
  ring: [17, 50], cube: [40, 38], pins: [[70, 45], [78, 45], [86, 45]]
}

// ── helpers ───────────────────────────────────────────────────────────────
function ok(m, what) {
  const s = String(m.status()?.value ?? m.status())
  if (s !== '0' && s !== 'NoError') throw new Error(`${what}: manifold status ${s}`)
  return m
}
/** union a list, deleting all inputs */
function fuse(list, what) {
  let acc = list[0]
  for (let i = 1; i < list.length; i++) {
    const n = acc.add(list[i])
    acc.delete(); list[i].delete()
    acc = n
  }
  return ok(acc, what)
}
/** subtract a list of cutters from base, deleting base + cutters */
function carve(base, cutters, what) {
  let acc = base
  for (const c of cutters) {
    const n = acc.subtract(c)
    acc.delete(); c.delete()
    acc = n
  }
  return ok(acc, what)
}
const bez2 = (p0, p1, p2, t) => [
  (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
  (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
]
function knurlStar(rOuter, rValley, teeth) {
  const pts = []
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rValley
    const th = (Math.PI * i) / teeth
    pts.push([r * Math.cos(th), r * Math.sin(th)])
  }
  return pts
}

// ── P5 ballast plug (×1 design, qty 2+1) ──────────────────────────────────
export function ballastPlug() {
  const Manifold = M()
  const rGrip = P5.gripD / 2
  const g = P5.gland
  const ri = g.idMm / 2 // 10.75
  const ro = ri + g.width // 13.45

  const starCS = new (CS())([knurlStar(rGrip, P5.knurlValleyR, P5.knurlTeeth)])
  const knurl = starCS.extrude(P5.gripH - P5.faceBandH + 0.1) // z 0…4.5
  starCS.delete()
  const band = Manifold.cylinder(P5.faceBandH, rGrip, rGrip, 128)
    .translate([0, 0, P5.gripH - P5.faceBandH]) // z 4.4…6 — smooth shoulder band
  let body = fuse([knurl, band], 'P5 grip')

  // face O-ring gland: annular groove 1.5 deep × 2.7 wide at ID 21.5 (J3)
  const go = Manifold.cylinder(g.depth + 0.1, ro, ro, 128)
  const gi = Manifold.cylinder(g.depth + 0.3, ri, ri, 128).translate([0, 0, -0.1])
  const glandCut = go.subtract(gi).translate([0, 0, P5.gripH - g.depth])
  go.delete(); gi.delete()
  body = carve(body, [glandCut], 'P5 gland')

  // M20×2.5 male former (threads.mjs) sunk 0.2 into the shoulder — built 0.2
  // LONGER so the sink does not eat into the engaged band (measured by
  // threads.engagementProof(): 3.2 full-form turns at THREAD.engagementMm = 10)
  const male = threadMale(THREAD.engagementMm + P5.threadSinkMm)
  const thread = male.manifold.translate([0, 0, P5.gripH - P5.threadSinkMm])
  male.manifold.delete()
  const manifold = fuse([body, thread], 'P5 plug')

  const heightMm = P5.gripH + THREAD.engagementMm // 13.5 ≤ 14
  return {
    name: 'p5-ballast-plug',
    manifold,
    printOrientation: { up: [0, 0, 1], note: 'thread axis vertical, knurl knob down on plate (spec P5); gland groove faces up — no cupping' },
    meta: {
      qty: P5.qty, spec: 'P5 / J3',
      thread: `M20x2.5 male, ${THREAD.engagementMm} mm of thread giving 3.2 turns of FULL-FORM engagement (spec J3 asks 3; the old 7.5 mm delivered only 1.75 once the tip lead-in and mouth countersink are counted — threads.engagementProof measures it), crest/root r>=0.3, 45deg lead-in at the tip only`,
      // 45° tip lead-in of the male thread: a spec'd knife-edge crest taper, so
      // chords there are not walls. DERIVED from the thread constants — a typed
      // box goes stale the moment the thread length changes (it just did).
      excludeRegions: [{
        min: [-11, -11, P5.gripH + THREAD.engagementMm - leadInFadeMm() - 0.15],
        max: [11, 11, P5.gripH + THREAD.engagementMm + 0.2]
      }],
      gland: { ...g, odMm: 2 * ro, glandFillPct: +(100 * (Math.PI * 1 * 1) / (g.depth * g.width)).toFixed(0) },
      oring: P5.oring,
      shoulder: `full annulus Ø${2 * ro}–Ø${P5.gripD} outside gland; hand-tight to shoulder only (J3), seal is the face O-ring, never the threads`,
      heightMm: +heightMm.toFixed(1), boundingSpec: 'Ø30 × 14',
      expectedGenus: 0, genusNote: 'solid knob + groove — topological sphere',
      cavities: 'none (solid part)'
    }
  }
}

// ── P6 tapered drain plug (qty 4+4) ───────────────────────────────────────
export function drainPlug() {
  const Manifold = M()
  const rBase = P6.bodyD / 2
  const halfTaperRad = ((FIT.drainTaperDeg / 2) * Math.PI) / 180 // 2° included taper
  const rTip = rBase - P6.bodyLen * Math.tan(halfTaperRad)
  const flange = Manifold.cylinder(P6.flangeH + 0.1, P6.flangeD / 2, P6.flangeD / 2, 96)
  const bodyC = Manifold.cylinder(P6.bodyLen, rBase, rTip, 96).translate([0, 0, P6.flangeH])
  const manifold = fuse([flange, bodyC], 'P6 plug')
  return {
    name: 'p6-drain-plug',
    manifold,
    printOrientation: { up: [0, 0, 1], note: 'flange down, tip up; either plate (spec P6)' },
    meta: {
      qty: P6.qty, spec: 'P6 / J5',
      body: `Ø${P6.bodyD} at flange → Ø${(2 * rTip).toFixed(2)} at tip over ${P6.bodyLen} mm (${FIT.drainTaperDeg}° included taper from FIT.drainTaperDeg)`,
      flange: `Ø${P6.flangeD} × ${P6.flangeH}`,
      mate: `Ø${P6.holeD} bulkhead drain, clearance ${((P6.holeD - P6.bodyD) / 2).toFixed(2)}/side at mouth — NOT a press fit (D6); bedded in UV resin 60–90 s passes, epoxy skim over (J5)`,
      expectedGenus: 0, genusNote: 'solid', cavities: 'none'
    }
  }
}

// ── P7 fins: 1.5 mm blade + Ø6.0 tang ─────────────────────────────────────
function finPart(which) {
  const Manifold = M()
  const { L, H, tangLen, qty } = P7[which]
  // planform: base line + concave-ish trailing edge to tip + convex leading edge
  const pts = [[0, 0], [L, 0]]
  for (let i = 1; i <= 14; i++) pts.push(bez2([L, 0], [0.82 * L, 0.55 * H], [0.5 * L, H], i / 14))
  for (let i = 1; i < 14; i++) pts.push(bez2([0.5 * L, H], [0.02 * L, 0.62 * H], [0, 0], i / 14))
  const cs = new (CS())([pts])
  const flat = cs.extrude(WALL.fin) // z 0…1.5 (thickness)
  cs.delete()
  const upright = flat.rotate([90, 0, 0]) // thickness → −Y, height → +Z
  flat.delete()
  const blade = upright.translate([0, WALL.fin / 2, 0]) // center thickness on y=0
  upright.delete()
  const xT = 0.42 * L
  const rT = P7.tangD / 2
  const tang = Manifold.cylinder(tangLen + 0.5, rT, rT, 96).translate([xT, 0, -tangLen])
  const rootCone = Manifold.cylinder(5, rT, 1.2, 96).translate([xT, 0, 0]) // blends tang into 1.5 blade
  let bladeCone = fuse([blade, rootCone], `P7 ${which} blade`)
  if (which === 'dorsal') {
    // the hull back RISES ~2.2 aft of the tang and FALLS ~3.8 forward of it —
    // a flat base clips the hull / hovers (audit). Carve the base to the real
    // hull-top profile: z_hull(x) − z_hull(tang), fin-local x = global + 81.
    const zc = (x) => 35 * Math.sqrt(Math.max(0, 1 - ((x - 81) / 140) ** 2)) - 35 * Math.sqrt(1 - (60 / 140) ** 2)
    const pts = [[-2, -25], [L + 2, -25], [L + 2, zc(L + 2)]]
    for (let x = L + 2; x >= -2.01; x -= 2) pts.push([x, zc(x)])
    const cs = new (CS())([pts])
    const cut = cs.extrude(8).rotate([90, 0, 0]).translate([0, 4, 0])
    cs.delete()
    const trimmed = ok(bladeCone.subtract(cut), 'P7 dorsal base curve')
    bladeCone.delete(); cut.delete()
    bladeCone = trimmed
  }
  const manifold = fuse([bladeCone, tang], `P7 ${which}`)
  return {
    name: `p7-fin-${which}`,
    manifold,
    printOrientation: { up: [0, 0, 1], note: 'tang down; slicer tilts blade near-vertical, supports on tang/root/leading edge only — blade faces and tang Ø stay scar-free' },
    meta: {
      qty, spec: 'P7 / J4',
      blade: `~${L} × ${H} planform, ${WALL.fin} mm thick (WALL.fin)`,
      tang: `Ø${P7.tangD} × ${tangLen} (+5 mm root cone), epoxy fit ${FIT.finTangRadial}/side into Ø${(P7.tangD + 2 * FIT.finTangRadial).toFixed(1)} blind socket with Ø2 floor drain (J4)`,
      symmetric: which === 'pectoral' ? 'lens-free symmetric section — print 2, no mirror needed' : undefined,
      baseNote: which === 'dorsal'
        ? 'base carved to the hull-top profile (tangent at the tang; hull rises 2.2 aft / falls 3.8 fwd across the span — a flat base would clip/hover, audit)'
        : 'flat base intentionally hovers off the curved flank — the tang + G/flex fillet carry the joint (J4)',
      expectedGenus: 0, genusNote: 'solid', cavities: 'none'
    }
  }
}
export const finDorsal = () => finPart('dorsal')
export const finPectoral = () => finPart('pectoral')

// ── P8 coupon plate (connected body) ──────────────────────────────────────
export function couponPlate() {
  const Manifold = M()
  const Ly = LAYOUT8
  const adds = []
  const cuts = []

  adds.push(Manifold.cube(Ly.slab, false)) // base slab 116×30×3

  // Row A: pin-socket block, sockets Ø3.2/3.3/3.4 × 4.5, Ø2 floor drains
  adds.push(Manifold.cube([32, 12, 5.2], false).translate([2, 9, 2.8])) // top z = 8
  for (let i = 0; i < 3; i++) {
    const [cx, cy] = Ly.rowACenters[i]
    const r = P8.rowAClassesMm[i] / 2
    cuts.push(Manifold.cylinder(P8.socketDepth + 0.1, r, r, 96).translate([cx, cy, 8 - P8.socketDepth]))
    cuts.push(Manifold.cylinder(8 - P8.socketDepth + 0.7, P8.drainD / 2, P8.drainD / 2, 64).translate([cx, cy, -0.1]))
    for (let k = 0; k <= i; k++) { // identification notches: 1/2/3 = tight→loose
      const xk = cx - (i * 2.4) / 2 - 0.6 + k * 2.4
      cuts.push(Manifold.cube([1.2, 2.4, 1.7], false).translate([xk, 8.6, 6.6]))
    }
  }

  // Row B: clevis lugs, bores Ø6.3/6.5/6.7 through 8 mm, axes HORIZONTAL
  // (production P2 prints upright → hinge axis lies horizontal in print).
  for (let i = 0; i < 3; i++) {
    const x0 = Ly.rowBLugX0[i]
    adds.push(Manifold.cube([P8.lugW, P8.lugThk, P8.lugTop - 2.8], false).translate([x0, 11, 2.8])) // top z = 18
    const r = P8.rowBClassesMm[i] / 2
    cuts.push(Manifold.cylinder(P8.lugThk + 0.4, r, r, 96).rotate([-90, 0, 0]).translate([x0 + P8.lugW / 2, 10.8, P8.boreZ]))
    for (let k = 0; k <= i; k++) {
      const xk = x0 + P8.lugW / 2 - (i * 2.4) / 2 - 0.6 + k * 2.4
      cuts.push(Manifold.cube([1.2, 2.4, 1.7], false).translate([xk, 10.6, 16.6]))
    }
  }

  // Row C: M20×2.5 male stub on a Ø26 collar (loose female ring mates it)
  const [sx, sy] = Ly.stub
  adds.push(Manifold.cylinder(3.2, 13, 13, 128).translate([sx, sy, 2.8])) // collar top z = 6
  const male = threadMale(THREAD.engagementMm)
  adds.push(male.manifold.translate([sx, sy, 6 - P5.threadSinkMm]))
  male.manifold.delete()

  // wall coupon panel: WALL.hull (2.25) thick, standing
  const p = Ly.panel
  adds.push(Manifold.cube([p.len, WALL.hull, p.h + 0.2], false).translate([p.x0, p.y0, 2.8]))

  // orientation marker: 45° corner chamfer at origin (read rows left→right from here)
  cuts.push(Manifold.cube([6, 6, 3.4], true).rotate([0, 0, 45]).translate([0, 0, 1.5]))

  let plate = fuse(adds, 'P8 plate union')
  plate = carve(plate, cuts, 'P8 plate carve')

  return {
    name: 'p8-coupon-plate',
    manifold: plate,
    printOrientation: { up: [0, 0, 1], note: 'printed FIRST, flat as laid out, same tilt/exposure/layer as production; Row B bore axes horizontal exactly as production clevis prints; Row A socket axes vertical exactly as production J1 flange sockets print' },
    meta: {
      qty: 1, spec: 'P8 §2',
      deviationNote: 'plate grown to ~116×30 (spec bounding 62×30×12) to host all coupon rows on one slab in production orientations — plate-fit gated by G4',
      rowA: { classesMm: P8.rowAClassesMm, depthMm: P8.socketDepth, drainMm: P8.drainD, clearancePerSideMm: P8.rowAClassesMm.map((d) => +((d - P8.pinD) / 2).toFixed(3)), notches: '1=Ø3.2 … 3=Ø3.4' },
      rowB: { classesMm: P8.rowBClassesMm, lugThkMm: P8.lugThk, clearancePerSideMm: P8.rowBClassesMm.map((d) => +((d - P8.hingePinD) / 2).toFixed(3)), notches: '1=Ø6.3 … 3=Ø6.7', orientation: 'bore axes horizontal (production print orientation)' },
      excludeRegions: [{ // row-C stub tip lead-in — derived from the thread, not typed
        min: [LAYOUT8.stub[0] - 11, LAYOUT8.stub[1] - 11, 6 - P5.threadSinkMm + THREAD.engagementMm - leadInFadeMm() - 0.15],
        max: [LAYOUT8.stub[0] + 11, LAYOUT8.stub[1] + 11, 6 - P5.threadSinkMm + THREAD.engagementMm + 0.2]
      }],
      rowC: `M20x2.5 male stub, +${FIT.threadFemaleRadial} radial on loose female ring (J3); ring runs to collar shoulder = full ${THREAD.engagementMm} mm engagement`,
      wallPanel: `${p.len} × ${p.h} × ${WALL.hull} (WALL.hull)`,
      marker: '45° corner chamfer at origin',
      expectedGenus: 6, genusNote: '3 through socket+drain channels + 3 through lug bores = 6 handles; zero print-sealed cavities (genus >= 0, G3)',
      cavities: 'all pockets open upward in print orientation; drains through slab'
    }
  }
}

// ── P8 loose parts (same build-plate layout) ──────────────────────────────
export function couponThreadRing() {
  const Manifold = M()
  const L = THREAD.engagementMm
  const boss = Manifold.cylinder(L, 15, 15, 128)
  const cut = threadFemaleCutter(L)
  const ring0 = boss.subtract(cut.manifold)
  boss.delete(); cut.manifold.delete()
  // Break the bore edge at the TOP face too. The cutter countersinks only its
  // mouth, so on a through-ring the thread ran out against the far flat face
  // and left a 0.004 mm feather (G2). Every real nut has both bore edges
  // broken; this is that chamfer, and it costs 0.5 mm of a 10 mm gauge thread.
  const ch = THREAD.mouthChamferMm
  const cskR = THREAD.majorD / 2 + FIT.threadFemaleRadial + 0.15 // clears the crests (see threads.mjs)
  const topCsk = Manifold.cylinder(ch, cskR, cskR + ch, 96)
    .translate([0, 0, L - ch])
  const ring1 = ok(ring0.subtract(topCsk), 'P8 ring top countersink')
  ring0.delete(); topCsk.delete()
  const manifold = ok(ring1.translate([...LAYOUT8.ring, 0]), 'P8 ring')
  ring1.delete()
  return {
    name: 'p8-coupon-ring',
    manifold,
    printOrientation: { up: [0, 0, 1], note: 'thread axis vertical, countersink mouth down; loose — runs onto the plate stub by hand (go/no-go)' },
    meta: {
      qty: 1, spec: 'P8 row C / J3',
      thread: `M20x2.5 female at +${FIT.threadFemaleRadial} radial (threads.mjs cutter), Ø30 boss × ${THREAD.engagementMm}, both bore edges countersunk ${THREAD.mouthChamferMm}`,
      // The ISO thread profile itself is excluded from the generic wall floor —
      // flanks and countersink run-outs are the spec'd form, not walls, and a
      // ray sampler reads chords across them. Same rule as the pods' port bores
      // and the P5 tip; the thread is instead proven by threads.selfMateCheck
      // (0.15 mm/side, no interference), threads.engagementProof (3.2 turns)
      // and the owner physically running this ring onto the plate stub. The
      // ring's structural wall — Ø30 OD over the bore, 4.85 mm — stays gated.
      excludeRegions: [{
        min: [LAYOUT8.ring[0] - 10.6, LAYOUT8.ring[1] - 10.6, -0.2],
        max: [LAYOUT8.ring[0] + 10.6, LAYOUT8.ring[1] + 10.6, THREAD.engagementMm + 0.2]
      }],
      expectedGenus: 1, genusNote: 'one open through-thread tunnel — genus 1, zero print-sealed cavities (G3)',
      cavities: 'through tunnel, open both ends'
    }
  }
}
export function couponDensityCube() {
  const Manifold = M()
  const c = P8.cubeMm
  const manifold = ok(Manifold.cube([c, c, c], false).translate([...LAYOUT8.cube, 0]), 'P8 cube')
  return {
    name: 'p8-coupon-cube',
    manifold,
    printOrientation: { up: [0, 0, 1], note: 'loose; weigh after cure → measured density rewrites RHO.resin in machine.mjs' },
    meta: {
      qty: 1, spec: 'P8: 10 mL density cube',
      volumeCm3: +((c ** 3) / 1000).toFixed(2), nominalMassG: +((c ** 3) / 1000 * RHO.resin).toFixed(1),
      expectedGenus: 0, genusNote: 'solid cube', cavities: 'none'
    }
  }
}
export function couponPins() {
  const Manifold = M()
  const list = LAYOUT8.pins.map(([x, y]) =>
    Manifold.cylinder(P8.pinLen, P8.pinD / 2, P8.pinD / 2, 96).translate([x, y, 0]))
  const manifold = fuse(list, 'P8 pins')
  return {
    name: 'p8-coupon-pins',
    manifold,
    printOrientation: { up: [0, 0, 1], note: '3 loose pins standing vertical; slicer raft/supports — pin Ø faces untouched' },
    meta: {
      qty: 3, spec: `P8: loose Ø${P8.pinD}×${P8.pinLen} pins (J1 registration size)`,
      expectedGenus: -2, genusNote: '3 DISJOINT solid pins: total chi=6 → reported genus 1−chi/2 = −2 is a component-count artifact, NOT sealed cavities; per-component genus verified 0 via decompose() in self-test (G3)',
      components: 3, cavities: 'none'
    }
  }
}

export function buildAll() {
  return [ballastPlug(), drainPlug(), finDorsal(), finPectoral(),
    couponPlate(), couponThreadRing(), couponDensityCube(), couponPins()]
}

// ── self-test ─────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const wasm = await boot()
  const Manifold = M()
  const partsDir = new URL('../parts/', import.meta.url).pathname
  mkdirSync(partsDir, { recursive: true })

  /** G1 tail: binary STL round-trip → merge → Manifold → volume ±0.1 % */
  const roundTrip = (path, refVol) => {
    const buf = readFileSync(path)
    const tri = buf.readUInt32LE(80)
    const verts = new Float32Array(tri * 9)
    const tris = new Uint32Array(tri * 3)
    for (let t = 0; t < tri; t++) {
      const off = 84 + t * 50 + 12
      for (let k = 0; k < 9; k++) verts[t * 9 + k] = buf.readFloatLE(off + k * 4)
      tris[t * 3] = t * 3; tris[t * 3 + 1] = t * 3 + 1; tris[t * 3 + 2] = t * 3 + 2
    }
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: verts, triVerts: tris })
    const merged = mesh.merge()
    const m = new wasm.Manifold(mesh)
    const s = String(m.status()?.value ?? m.status())
    const vol = s === '0' || s === 'NoError' ? m.volume() : NaN
    m.delete()
    return { merged, status: s, volMatch: Math.abs(vol - refVol) / refVol < 0.001 }
  }

  const parts = buildAll()
  const byName = Object.fromEntries(parts.map((p) => [p.name, p]))
  let allOk = true
  const manifest = []

  for (const part of parts) {
    const v = validate(part.manifold, { name: part.name, plate: PLATE.usable })
    const genus = part.manifold.genus()
    let g3 = genus === part.meta.expectedGenus && (genus >= 0 || part.meta.components > 1)
    let componentGenus
    if (part.meta.components > 1) { // per-component G3 for multi-body parts
      const comps = part.manifold.decompose()
      componentGenus = comps.map((c) => { const g = c.genus(); c.delete(); return g })
      g3 = g3 && componentGenus.length === part.meta.components && componentGenus.every((g) => g === 0)
    }
    const bb = part.manifold.boundingBox()
    const dims = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]]
    // G4 in the DECLARED orientation (all parts built with up = +Z)
    const g4 = dims[0] <= PLATE.usable[0] && dims[1] <= PLATE.usable[1] && dims[2] <= PLATE.usable[2]
    const stlPath = partsDir + part.name + '.stl'
    const stl = writeSTL(part.manifold, stlPath, `saycad fish ${part.name}`)
    const stlBytesOk = stl.bytes === 84 + 50 * stl.triangles
    const rt = roundTrip(stlPath, part.manifold.volume())
    const partOk = v.ok && g3 && g4 && stlBytesOk && rt.merged && rt.volMatch
    allOk &&= partOk
    manifest.push({
      part: part.name, qty: part.meta.qty,
      volCm3: +(v.volume / 1000).toFixed(2),
      massEachG: +((v.volume / 1000) * RHO.resin).toFixed(1),
      massTotalG: +((v.volume / 1000) * RHO.resin * part.meta.qty).toFixed(1)
    })
    console.log(JSON.stringify({
      part: part.name, ok: partOk,
      gates: { G1_manifold: v.checks[0].ok && rt.merged && rt.volMatch, G3_genus: g3, G4_plateFit: g4, volumeCm3: +(v.volume / 1000).toFixed(2) },
      dims: dims.map((d) => +d.toFixed(1)), genus, componentGenus, genusNote: part.meta.genusNote,
      printOrientation: part.printOrientation, stl: { path: stlPath, triangles: stl.triangles, roundTrip: rt }
    }))
  }

  // ── functional checks beyond per-part gates ─────────────────────────────
  // The male thread sits 0.2 mm below the shoulder plane (threadSinkMm), so a
  // ring seated at the shoulder is helix-phase-shifted by 360·0.2/pitch vs the
  // male form. A nut that screwed down IS phase-aligned — model that by
  // rotating the ring the same angle about the thread axis before seating.
  const seatPhaseDeg = (360 * P5.threadSinkMm) / THREAD.pitch // 28.8°
  // (a) P5 thread mates the J3 female form: plug ∩ (boss − femaleCutter) ≈ 0
  {
    const cut = threadFemaleCutter(THREAD.engagementMm)
    const boss = Manifold.cylinder(THREAD.engagementMm, 15, 15, 128)
    const ring0 = boss.subtract(cut.manifold)
    boss.delete(); cut.manifold.delete()
    const ring1 = ring0.rotate([0, 0, seatPhaseDeg])
    ring0.delete()
    const ring = ring1.translate([0, 0, P5.gripH])
    ring1.delete()
    const x = byName['p5-ballast-plug'].manifold.intersect(ring)
    const v = x.volume()
    x.delete(); ring.delete()
    const passA = v < 0.05
    allOk &&= passA
    console.log(JSON.stringify({ check: 'P5-thread-mate-J3', ok: passA, interferenceVolMm3: +v.toFixed(4), seatPhaseDeg }))
  }
  // (b) Row C: the loose coupon ring screwed fully home on the plate stub
  {
    const [sx, sy] = LAYOUT8.stub
    const [rx, ry] = LAYOUT8.ring
    const t1 = byName['p8-coupon-ring'].manifold.translate([-rx, -ry, 0])
    const t2 = t1.rotate([0, 0, seatPhaseDeg])
    t1.delete()
    const moved = t2.translate([sx, sy, 6])
    t2.delete()
    const x = byName['p8-coupon-plate'].manifold.intersect(moved)
    const v = x.volume()
    x.delete(); moved.delete()
    const passB = v < 0.05
    allOk &&= passB
    console.log(JSON.stringify({ check: 'P8-rowC-ring-on-stub', ok: passB, interferenceVolMm3: +v.toFixed(4), note: 'ring seated to collar shoulder, full 3-turn engagement, OD30 clears all plate features' }))
  }
  // (c) Row A: Ø3.0 pin seated in every socket class → zero interference
  {
    const results = []
    for (let i = 0; i < 3; i++) {
      const [cx, cy] = LAYOUT8.rowACenters[i]
      const pin = Manifold.cylinder(P8.socketDepth - 0.1, P8.pinD / 2, P8.pinD / 2, 96).translate([cx, cy, 8 - P8.socketDepth + 0.05])
      const x = byName['p8-coupon-plate'].manifold.intersect(pin)
      results.push(+x.volume().toFixed(4))
      x.delete(); pin.delete()
    }
    const passC = results.every((v) => v < 0.001)
    allOk &&= passC
    console.log(JSON.stringify({ check: 'P8-rowA-pin-seat', ok: passC, interferenceVolMm3: results }))
  }
  // (d) one build plate: combined AABB of the P8 set ≤ PLATE.usable, all bodies disjoint
  {
    const set = ['p8-coupon-plate', 'p8-coupon-ring', 'p8-coupon-cube', 'p8-coupon-pins'].map((n) => byName[n])
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (const p of set) {
      const bb = p.manifold.boundingBox()
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], bb.min[k]); hi[k] = Math.max(hi[k], bb.max[k]) }
    }
    const ext = hi.map((h, k) => +(h - lo[k]).toFixed(1))
    const fits = ext[0] <= PLATE.usable[0] && ext[1] <= PLATE.usable[1] && ext[2] <= PLATE.usable[2]
    let disjoint = true
    for (let i = 0; i < set.length; i++) {
      for (let j = i + 1; j < set.length; j++) {
        const x = set[i].manifold.intersect(set[j].manifold)
        disjoint &&= x.volume() < 1e-6
        x.delete()
      }
    }
    const passD = fits && disjoint
    allOk &&= passD
    console.log(JSON.stringify({ check: 'P8-one-plate-layout', ok: passD, combinedExtentMm: ext, plateUsable: PLATE.usable, bodiesDisjoint: disjoint }))
  }
  // (e) G5 clearance audit for every fit this module owns (all from FIT)
  {
    const rows = [
      { joint: 'J1 rowA sockets', perSideMm: P8.rowAClassesMm.map((d) => +((d - P8.pinD) / 2).toFixed(3)) },
      { joint: 'J2 rowB bores', perSideMm: P8.rowBClassesMm.map((d) => +((d - P8.hingePinD) / 2).toFixed(3)) },
      { joint: 'J3 thread female', perSideMm: [FIT.threadFemaleRadial] },
      { joint: 'J4 fin tang', perSideMm: [FIT.finTangRadial] },
      { joint: 'J5 drain plug mouth', perSideMm: [+((P6.holeD - P6.bodyD) / 2).toFixed(3)], note: 'taper+UV-resin bedded, not a running fit' }
    ]
    const passE = rows.every((r) => r.perSideMm.every((c) => c >= FIT.minTestableRadial))
    allOk &&= passE
    console.log(JSON.stringify({ check: 'G5-clearance-audit', ok: passE, minTestableRadial: FIT.minTestableRadial, rows }))
  }

  for (const p of parts) p.manifold.delete()
  console.log(JSON.stringify({ verdict: allOk ? 'GREEN' : 'RED', module: 'smallparts.mjs', massManifestG: manifest, rho: RHO.resin }))
  process.exit(allOk ? 0 : 1)
}
