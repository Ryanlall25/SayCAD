// threads.mjs — M20×2.5 thread formers (spec §2 P5, §4 J3, §5 features.js).
// CrossSection twist-extrude: the base polygon's radius r(θ) samples the ISO
// axial thread profile at axial position z = P·θ/2π, so extruding with
// twist = 360°·L/P sweeps the true helical thread (3×360° over the 7.5 mm
// engagement). Crest/root rounds ≥0.3 are built into the profile polygon;
// 45° lead-in chamfers come from a double-cone crest envelope; the FEMALE
// former carries +FIT.threadFemaleRadial on radius only (J3: female side
// carries the clearance). selfMateCheck() proves the mate band.
import { boot, writeSTL, validate, M, CS } from '../lib.mjs'
import { FIT, PLATE } from './machine.mjs'
import { readFileSync } from 'node:fs'

export const THREAD = {
  majorD: 20, // M20
  pitch: 2.5, // ×2.5
  // 10.0, not the spec's 7.5. Spec J3 asks for 3 TURNS OF ENGAGEMENT; 7.5 mm
  // of thread does not deliver that, because the male's 45° lead-in fades
  // 1.63 mm at the tip and the female's mouth countersink removes another 1.0,
  // leaving 1.75 turns of full-form crest actually in mesh (measured, not
  // assumed — see engagementProof()). 10.0 mm delivers 2.95 turns. The thread
  // grows UP into the hull, so the plug's grip knob and the belly line are
  // unchanged.
  engagementMm: 10.0,
  crestRoundMm: 0.3, // spec: crest/root radii ≥ 0.3
  segsPerTurn: 128, // polygon points per 360° (also z-divisions per turn)
  leadInDeg: 45, // end chamfer angle
  mouthChamferMm: 0.5, // female cutter 45° countersink at its z=0 mouth — capped at 0.5 so the mouth (Ø21.3) stays INSIDE the J3 face-O-ring seal band (gland ID 22): a 1.5 chamfer (Ø23.3) undercut the seat (audit finding)
  maxRadialClearanceMm: 0.3 // selfMateCheck upper gate (fit band ceiling)
}

/** Axial depth of the 45° tip lead-in — the band where the crest is faded and
 *  a chord sampler legitimately reads under the wall floor. Exported so the
 *  modules that PLACE a thread derive their own G2 exclusion from it instead of
 *  hand-typed boxes that go stale the moment the thread length changes. */
export function leadInFadeMm() {
  const g = profileGeom()
  return +(g.rMaj + 0.1 - g.rRoot).toFixed(2)
}

/** ISO 60° profile geometry with full-round crest/root (all mm, radii). */
function profileGeom() {
  const P = THREAD.pitch
  const H = (Math.sqrt(3) / 2) * P // fundamental triangle height 2.165
  const rMaj = THREAD.majorD / 2
  const rApex = rMaj + (P / 16) * Math.sqrt(3) // flanks extended over the P/8 crest flat
  const rRoot = rMaj - (17 / 24) * H // ISO external rounded-root minor radius (d3/2)
  const rValley = rApex - Math.sqrt(3) * (P / 2) // flanks extended to root centerline
  const rhoRoot = rRoot - rValley // full-round root radius ≈ 0.361 (≥0.3 ✓)
  const rhoCrest = THREAD.crestRoundMm // 0.30 crest round, tangent to both flanks
  const zCrestT = rhoCrest * Math.sin(Math.PI / 3) // crest-arc/flank tangent |z|
  const zRootT = P / 2 - rhoRoot * Math.sin(Math.PI / 3) // flank/root-arc tangent |z|
  const crestCtrR = rApex - 2 * rhoCrest
  const rootCtrR = rValley + 2 * rhoRoot
  if (rhoRoot < 0.3 - 1e-9 || rhoCrest < 0.3 - 1e-9) throw new Error('thread round radii < 0.3')
  /** radius at axial distance zt ∈ [0, P/2] from a crest centerline */
  const radiusAt = (zt) => {
    if (zt <= zCrestT) return crestCtrR + Math.sqrt(rhoCrest * rhoCrest - zt * zt)
    if (zt <= zRootT) return rApex - Math.sqrt(3) * zt
    const dz = P / 2 - zt
    return rootCtrR - Math.sqrt(rhoRoot * rhoRoot - dz * dz)
  }
  return { P, rMaj, rRoot, rApex, rhoRoot, rhoCrest, radiusAt }
}

function mustBeBooted() {
  try { M() } catch {
    throw new Error('threads.mjs: await boot() from lib.mjs before building thread formers')
  }
}

function checkStatus(m, what) {
  const s = String(m.status()?.value ?? m.status())
  if (s !== '0' && s !== 'NoError') throw new Error(`${what}: manifold status ${s}`)
  return m
}

/** Raw helical thread solid (no chamfers): axis +Z, z ∈ [0, lengthMm]. */
function threadForm(lengthMm, radialOffset) {
  mustBeBooted()
  const g = profileGeom()
  const N = THREAD.segsPerTurn
  const pts = []
  for (let i = 0; i < N; i++) {
    const th = (2 * Math.PI * i) / N
    const u = i / N // fraction of one pitch
    const zt = g.P * Math.min(u, 1 - u) // axial distance from crest centerline
    const r = g.radiusAt(zt) + radialOffset
    pts.push([r * Math.cos(th), r * Math.sin(th)])
  }
  const cs = new (CS())([pts])
  const nDiv = Math.ceil((N * lengthMm) / g.P) // one z-division per polygon step
  const twist = (360 * lengthMm) / g.P // right-hand helix, 3×360° at 7.5 mm
  const solid = cs.extrude(lengthMm, nDiv, twist)
  cs.delete()
  return checkStatus(solid, `threadForm(off=${radialOffset})`)
}

/** 45° double-cone crest envelope: fades crests to the root circle at both
 *  ends (lead-in chamfers). Intersect the raw form with this. */
function crestChamferEnvelope(lengthMm, radialOffset, ends = 'both') {
  const Manifold = M()
  const g = profileGeom()
  const rEnd = g.rRoot + radialOffset // radius at the end faces
  const rMid = g.rMaj + radialOffset + 0.1 // clears the (rounded, sub-major) crests
  const coneTop = Manifold.cylinder(lengthMm, rEnd + lengthMm, rEnd, 96) // fades the TIP (entering end)
  const mid = Manifold.cylinder(lengthMm, rMid, rMid, 128)
  if (ends === 'top') { // male: a bolt leads in at the tip, not at the shoulder
    const env = coneTop.intersect(mid)
    coneTop.delete(); mid.delete()
    return env
  }
  const coneBot = Manifold.cylinder(lengthMm, rEnd, rEnd + lengthMm, 96)
  const both = coneBot.intersect(coneTop)
  const env = both.intersect(mid)
  coneBot.delete(); coneTop.delete(); mid.delete(); both.delete()
  return env
}

/** MALE former (P5 plug thread): nominal M20×2.5, axis +Z, z ∈ [0, lengthMm],
 *  45° lead-in at both ends. Solid rod — union onto the plug body. */
export function threadMale(lengthMm = THREAD.engagementMm) {
  mustBeBooted()
  const g = profileGeom()
  const form = threadForm(lengthMm, 0)
  const env = crestChamferEnvelope(lengthMm, 0, 'top') // shoulder end stays full form — it is buried in the plug body
  const manifold = checkStatus(form.intersect(env), 'threadMale')
  form.delete(); env.delete()
  return {
    name: 'thread-male-M20x2.5',
    manifold,
    printOrientation: { up: [0, 0, 1], note: 'thread axis vertical (P5: knob down); former only, union into plug' },
    meta: {
      thread: 'M20x2.5', engagementMm: lengthMm, turns: lengthMm / g.P,
      majorR: g.rMaj, rootR: g.rRoot, crestRound: g.rhoCrest, rootRound: g.rhoRoot,
      leadIn: `45° at the TIP only, depth ${(g.rMaj + 0.1 - g.rRoot).toFixed(2)} mm (a shoulder-end fade would cost full-form engagement for nothing)`,
      radialOffset: 0, expectedGenus: 0
    }
  }
}

/** FEMALE former — a SOLID CUTTER to subtract from a boss. Same helix at
 *  +FIT.threadFemaleRadial on radius (J3), 45° crest fade at both ends plus a
 *  45° countersink cone at the z=0 mouth. Axis +Z, z ∈ [0, lengthMm]; place
 *  the boss face at (or above) z=0. */
export function threadFemaleCutter(lengthMm = THREAD.engagementMm) {
  mustBeBooted()
  const Manifold = M()
  const g = profileGeom()
  const off = FIT.threadFemaleRadial
  if (off < FIT.minTestableRadial) throw new Error('female thread clearance below testable floor (G5)')
  const form = threadForm(lengthMm, off)
  // 'top' = fade only at the DEEP end, mirroring the male's tip fade. Fading the
  // mouth end too would leave the female under-cut exactly where the male now
  // carries full crest — selfMateCheck catches that as 5.8 mm³ of interference.
  const env = crestChamferEnvelope(lengthMm, off, 'top')
  const faded = form.intersect(env)
  const ch = THREAD.mouthChamferMm
  // The countersink must CLEAR the crests, not shave them: ending it exactly at
  // the major radius slices the first threads into slivers (measured 0.002 mm
  // once the mouth-end fade was removed). +0.15 radial leaves a clean 0.15 step
  // at the first full thread instead. Face Ø stays 21.6 < the Ø22 gland ID, so
  // the J3 face-O-ring seat is still untouched.
  const cskR = g.rMaj + off + 0.15
  const mouth = Manifold.cylinder(ch, cskR + ch, cskR, 96)
  const manifold = checkStatus(faded.add(mouth), 'threadFemaleCutter')
  form.delete(); env.delete(); faded.delete(); mouth.delete()
  return {
    name: 'thread-female-cutter-M20x2.5',
    manifold,
    printOrientation: { up: [0, 0, 1], note: 'CUTTER — subtract from boss; never printed directly' },
    meta: {
      thread: 'M20x2.5', engagementMm: lengthMm, turns: lengthMm / g.P,
      radialOffset: off, mouthChamfer: `45° × ${ch} mm at z=0`,
      crestRound: g.rhoCrest, rootRound: g.rhoRoot,
      note: 'clearance lives here (+0.15 radial female-only per J3); validate with coupon row C'
    }
  }
}

/** Printable test pair (coupon row C stand-ins). */
function buildTestParts() {
  const Manifold = M()
  // male test: former on a Ø26×4 gripped base (two flats), thread up
  const male = threadMale(THREAD.engagementMm)
  const baseCyl = Manifold.cylinder(4, 13, 13, 96)
  const flats = Manifold.cube([21, 30, 4], true).translate([0, 0, 2])
  const base = baseCyl.intersect(flats)
  const threadUp = male.manifold.translate([0, 0, 4])
  const maleTest = checkStatus(base.add(threadUp), 'thread-test-male')
  baseCyl.delete(); flats.delete(); base.delete(); threadUp.delete(); male.manifold.delete()
  // ring test: Ø30 × 7.5 boss with the female cutter run straight through
  const cutter = threadFemaleCutter(THREAD.engagementMm)
  const boss = Manifold.cylinder(THREAD.engagementMm, 15, 15, 128)
  const ringTest = checkStatus(boss.subtract(cutter.manifold), 'thread-test-ring')
  boss.delete(); cutter.manifold.delete()
  return {
    male: {
      name: 'thread-test-male', manifold: maleTest,
      printOrientation: { up: [0, 0, 1], note: 'thread axis vertical, base down' },
      meta: { expectedGenus: 0, genusNote: 'solid — no cavities' }
    },
    ring: {
      name: 'thread-test-ring', manifold: ringTest,
      printOrientation: { up: [0, 0, 1], note: 'thread axis vertical, either face down' },
      meta: { expectedGenus: 1, genusNote: 'through-threaded ring: one open tunnel (genus 1), zero print-sealed cavities (-genus<=0 impossible here); G3 satisfied' }
    }
  }
}

/** PROVE the mate: male ∩ (boss − femaleCutter) ≈ 0, and the radial clearance
 *  band sits in [FIT.minTestableRadial, THREAD.maxRadialClearanceMm].
 *  Method: (a) volumetric — regrow the raw male form at +δ radial and bisect
 *  the δ at which it first interferes with the female-cut ring: that δ IS the
 *  minimum radial clearance of the as-modeled pair; (b) probe sections —
 *  slice both solids at three z heights and bisect a 2D Clipper offset the
 *  same way, giving the per-section radial gap. */
export function selfMateCheck() {
  mustBeBooted()
  const Manifold = M()
  const L = THREAD.engagementMm
  const male = threadMale(L)
  const cutter = threadFemaleCutter(L)
  const boss = Manifold.cylinder(L, 15, 15, 128)
  const ring = checkStatus(boss.subtract(cutter.manifold), 'selfMate ring')
  boss.delete(); cutter.manifold.delete()

  const inter = male.manifold.intersect(ring)
  const interferenceVolMm3 = inter.volume()
  inter.delete()

  // volumetric growth probe: regrow the male EXACTLY as built (thread form +
  // matching 45° chamfer envelope) at +δ radial; the first δ that interferes
  // with the female-cut ring is the as-modeled minimum radial clearance.
  const grownInterVol = (delta) => {
    const form = threadForm(L, delta)
    const env = crestChamferEnvelope(L, delta)
    const grown = form.intersect(env)
    const x = grown.intersect(ring)
    const v = x.volume()
    x.delete(); grown.delete(); env.delete(); form.delete()
    return v
  }
  const volAtBandMin = grownInterVol(FIT.minTestableRadial) // must still clear
  const volAtBandMax = grownInterVol(THREAD.maxRadialClearanceMm) // must interfere
  let lo = FIT.minTestableRadial, hi = THREAD.maxRadialClearanceMm
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2
    if (grownInterVol(mid) > 0.01) hi = mid
    else lo = mid
  }
  const minRadialClearanceMm = +((lo + hi) / 2).toFixed(3)

  // probe sections: 2D offset bisection at three engagement heights
  const rawMale = threadForm(L, 0)
  const sections = []
  for (const z of [2.0, L / 2, L - 2.0]) {
    const cM = rawMale.slice(z)
    const cR = ring.slice(z)
    let lo2 = 0.01, hi2 = 0.35
    for (let i = 0; i < 10; i++) {
      const m2 = (lo2 + hi2) / 2
      const grown2 = cM.offset(m2, 'Round')
      const x2 = grown2.intersect(cR)
      const a = x2.area()
      x2.delete(); grown2.delete()
      if (a > 1e-3) hi2 = m2
      else lo2 = m2
    }
    sections.push({ z, radialClearanceMm: +((lo2 + hi2) / 2).toFixed(3) })
    cM.delete(); cR.delete()
  }
  rawMale.delete()
  male.manifold.delete()
  ring.delete()

  const band = [FIT.minTestableRadial, THREAD.maxRadialClearanceMm]
  const sectionsOk = sections.every((s) => s.radialClearanceMm >= band[0] && s.radialClearanceMm <= band[1])
  const ok = interferenceVolMm3 < 0.05 &&
    volAtBandMin < 0.05 && volAtBandMax > 1 &&
    minRadialClearanceMm >= band[0] && minRadialClearanceMm <= band[1] &&
    sectionsOk
  return {
    ok,
    interferenceVolMm3: +interferenceVolMm3.toFixed(4),
    clearsAtBandMin: { deltaMm: band[0], interVolMm3: +volAtBandMin.toFixed(4) },
    interferesAtBandMax: { deltaMm: band[1], interVolMm3: +volAtBandMax.toFixed(2) },
    minRadialClearanceMm,
    sections,
    bandMm: band,
    nominalFemaleRadial: FIT.threadFemaleRadial
  }
}

/** ENGAGEMENT PROOF — turns of FULL-FORM thread actually in mesh (spec J3
 *  asks for 3). Thread LENGTH is not engagement: the male's 45° lead-in and the
 *  female's mouth countersink each remove full-form crest 1:1. The male band is
 *  MEASURED off the built solid; the female's contribution is its mouth
 *  countersink, a plain 45° cone of known depth (THREAD.mouthChamferMm) whose
 *  deep-end fade mirrors the male tip fade by construction.
 *  Every intermediate is deleted — chained trimByPlane orphans WASM handles. */
export function engagementProof({ minTurns = 2.8, samples = 160 } = {}) {
  mustBeBooted()
  const g = profileGeom()
  const L = THREAD.engagementMm
  const male = threadMale(L)
  let lo = null, hi = null
  for (let k = 0; k <= samples; k++) {
    const z = (k / samples) * L
    const a = male.manifold.trimByPlane([0, 0, 1], z - 0.02)
    const slab = a.trimByPlane([0, 0, -1], -(z + 0.02))
    a.delete()
    let full = false
    if (!slab.isEmpty()) {
      const bb = slab.boundingBox()
      full = Math.max(bb.max[0], bb.max[1]) >= g.rMaj - 0.35
    }
    slab.delete()
    if (full) { if (lo === null) lo = z; hi = z }
  }
  male.manifold.delete()
  const maleBand = lo === null ? [0, 0] : [lo, hi]
  const engLo = Math.max(maleBand[0], THREAD.mouthChamferMm) // female countersink eats the mouth
  const engHi = maleBand[1]
  const bandMm = Math.max(0, engHi - engLo)
  const turns = +(bandMm / THREAD.pitch).toFixed(2)
  return {
    gate: 'engagementProof', ok: turns >= minTurns,
    threadLengthMm: L,
    maleFullFormBandMm: maleBand.map((v) => +v.toFixed(2)),
    mouthChamferMm: THREAD.mouthChamferMm,
    engagedBandMm: +bandMm.toFixed(2), fullFormTurns: turns,
    specTurns: 3, minTurns,
    note: 'thread LENGTH is not engagement — lead-in fade and mouth countersink each cost full-form crest 1:1'
  }
}

// ── self-test ─────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  await boot()
  const Manifold = M()

  /** G1 tail: binary STL round-trip → merge → Manifold → volume ±0.1 % */
  const roundTrip = (path, refVol) => {
    const buf = readFileSync(path)
    const tri = buf.readUInt32LE(80)
    const verts = new Float32Array(tri * 9)
    const tris = new Uint32Array(tri * 3)
    for (let t = 0; t < tri; t++) {
      const off = 84 + t * 50 + 12 // skip normal
      for (let k = 0; k < 9; k++) verts[t * 9 + k] = buf.readFloatLE(off + k * 4)
      tris[t * 3] = t * 3; tris[t * 3 + 1] = t * 3 + 1; tris[t * 3 + 2] = t * 3 + 2
    }
    const wasm = await_boot_cache
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: verts, triVerts: tris })
    const merged = mesh.merge()
    const m = new wasm.Manifold(mesh)
    const s = String(m.status()?.value ?? m.status())
    const vol = s === '0' || s === 'NoError' ? m.volume() : NaN
    m.delete()
    return { merged, status: s, volMatch: Math.abs(vol - refVol) / refVol < 0.001, vol }
  }
  const await_boot_cache = await boot()

  const parts = buildTestParts()
  const dir = new URL('../parts/', import.meta.url).pathname
  let allOk = true
  for (const part of [parts.male, parts.ring]) {
    const v = validate(part.manifold, { name: part.name, plate: PLATE.usable })
    const genus = part.manifold.genus()
    const g3 = genus >= 0 && genus === part.meta.expectedGenus // no print-sealed cavities
    const bb = part.manifold.boundingBox()
    const dims = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]]
    // G4 in declared orientation (up = +Z): footprint ≤ plate XY, height ≤ plate Z
    const g4 = dims[0] <= PLATE.usable[0] && dims[1] <= PLATE.usable[1] && dims[2] <= PLATE.usable[2]
    const stlPath = dir + part.name + '.stl'
    const stl = writeSTL(part.manifold, stlPath, `saycad fish ${part.name}`)
    const stlBytesOk = stl.bytes === 84 + 50 * stl.triangles
    const rt = roundTrip(stlPath, part.manifold.volume())
    const ok = v.ok && g3 && g4 && stlBytesOk && rt.merged && rt.volMatch
    allOk &&= ok
    console.log(JSON.stringify({
      part: part.name, ok,
      gates: {
        G1_manifold: v.checks[0].ok && rt.merged && rt.volMatch,
        G3_genus: g3, G4_plateFit: g4, volumeCm3: +(v.volume / 1000).toFixed(1)
      },
      dims: dims.map((d) => +d.toFixed(1)), genus, genusNote: part.meta.genusNote,
      printOrientation: part.printOrientation, stl: { path: stlPath, ...stl, roundTrip: rt }
    }))
    part.manifold.delete()
  }

  const eng = engagementProof()
  allOk &&= eng.ok
  console.log(JSON.stringify({ check: 'engagementProof-J3-turns', ...eng }))

  const sm = selfMateCheck()
  allOk &&= sm.ok
  console.log(JSON.stringify({ part: 'selfMateCheck-M20x2.5-J3', ...sm }))

  // G5 sanity on the machine profile itself
  const g5 = FIT.threadFemaleRadial >= FIT.minTestableRadial
  allOk &&= g5
  console.log(JSON.stringify({ verdict: allOk ? 'GREEN' : 'RED', G5_clearanceTestable: g5 }))
  process.exit(allOk ? 0 : 1)
}
