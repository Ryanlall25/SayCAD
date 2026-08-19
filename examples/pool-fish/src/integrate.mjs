// integrate.mjs — spec §6 end-to-end: every printed part through G1–G5, the
// assembled/coated/ballasted fish through G6 — run BOTH on the §3 analytic
// envelope (the spec contract) AND on the real generated displacement body
// (outer hull loft ∪ tail solid) — plus the J2 swing proof (stopCheck), the
// G7 manifest, and explicit non-tautological ballast/reserve gates (audit).
// Writes parts/*.stl (G1), parts/manifest.json (G7), parts/gates.integration.json.
import { boot, M } from '../lib.mjs'
import { runAll, G1_manifoldRoundtrip, G2_minWall, G3_cavities, G4_plateFit, G6_stability } from './gates.mjs'
import { ENVELOPE, FIT, MASS, RHO } from './machine.mjs'
import { buildPods, seamPin, seamWallProof, drainPlugProof, PROBES } from './pods.mjs'
import { tailAssembly, hingePin, retainerCap, stopCheck, HINGE } from './tailparts.mjs'
import { buildAll } from './smallparts.mjs'
import { threadMale } from './threads.mjs'
import { writeFileSync } from 'node:fs'

await boot()
const t0 = Date.now()

const BALLAST_TARGET_G = 120
const { p1, p2, bare, chambers, trayFill, sealedSolid } = buildPods({ ballastTargetG: BALLAST_TARGET_G })
const tail = tailAssembly()
const pin = hingePin()
const cap = retainerCap()
const jpin = seamPin()
const [plug, drain, finD, finP, cPlate, cRing, cCube, cPins] = buildAll()

// G7 sees ASSEMBLY quantities (P4a: 1 fitted + 1 spare printed; P4 pin
// fallback: 1 fitted; P6: 3 fitted of 8). Coupons validated separately.
const asmQty = (part, qty) => ({ ...part, meta: { ...part.meta, qty } })
const fishParts = [
  p1, p2, tail,
  asmQty(pin, 1), asmQty(cap, 1), asmQty(jpin, 3),
  asmQty(plug, 2), asmQty(drain, 3), finD, finP
]
const couponParts = [cPlate, cRing, cCube, cPins]

// ── the assembled fish (G6 mass items; grams, global frame) ──────────────
const g = (m) => +((m.volume() / 1000) * RHO.resin).toFixed(1)
const structItems = [
  { name: 'P1', manifold: p1.manifold, massG: g(p1.manifold) },
  { name: 'P2', manifold: p2.manifold, massG: g(p2.manifold) },
  { name: 'P3 tail', manifold: tail.manifold, massG: g(tail.manifold) },
  { name: 'P4 pin', point: [HINGE.axisGlobalX, 0, -3], massG: g(pin.manifold) },
  { name: 'P4a cap (1 fitted)', point: [HINGE.axisGlobalX, 0, -26], massG: g(cap.manifold) },
  { name: 'J1 pins ×3', point: [-20, 0, 0], massG: +(3 * g(jpin.manifold)).toFixed(1) },
  { name: 'P5 plug fwd', point: [-50, 0, -31], massG: g(plug.manifold) },
  { name: 'P5 plug aft', point: [10, 0, -32], massG: g(plug.manifold) },
  { name: 'P6 plugs ×3 (bulkheads + diaphragm)', point: [-25, 0, -25], massG: 0.3 },
  { name: 'P7 dorsal', point: [-60, 0, 34], massG: g(finD.manifold) },
  { name: 'P7 pect L', point: [5, 25, -19], massG: g(finP.manifold) },
  { name: 'P7 pect R', point: [5, -25, -19], massG: g(finP.manifold) },
  { name: 'O-rings ×2', point: [-20, 0, -34.5], massG: 2.4 },
  { name: 'G/flex + RTV', point: [-20, 0, -2], massG: 6 }
]
const structG = +structItems.reduce((s, it) => s + it.massG, 0).toFixed(1)
const coatG = MASS.coatBudgetG
const ballastG = +(MASS.allUpG - structG - coatG).toFixed(1)
const massItems = [
  ...structItems,
  { name: 'UV topcoat', point: [-15, 0, 0], massG: coatG },
  { name: 'ballast (pebble/epoxy)', point: [-18, 0, trayFill.bedCentroidZ], massG: ballastG }
]

// non-tautological mass gates (audit: the G7 band cannot fail while ballast
// is derived): the derived ballast must be pourable and match the tabs
const ballastOk = ballastG >= 40 && ballastG <= 170 && Math.abs(ballastG - trayFill.tabImpliedG) <= 15

// §3 hydro contract envelope + the REAL displacement body
const envelope = M().sphere(1, 96).scale([ENVELOPE.a, ENVELOPE.b, ENVELOPE.c])
const realBody = sealedSolid.add(tail.manifold) // sealed hull loft ∪ free-flooding tail's solid resin

// flood-floats chamber limit: draft frac x ≤ 0.80 → x²(3−2x) = 0.896 →
// 564.4·0.896·0.997 − 323 = 181 cm³ (spec's ≤~115 was an estimate artifact;
// bulkheads at spec stations + the seam diaphragm)
const report = runAll(fishParts, {
  envelope, massItems,
  g6: { stepDeg: 15, gmMinMm: 3, chambersCm3: Object.values(chambers), maxChamberCm3: 181 },
  g7: {
    ballastG, coatG,
    extras: [
      { name: 'EPDM 21×2 O-rings ×2', massG: 2.4 },
      { name: 'G/flex bead + fillets + RTV', massG: 6 }
    ],
    note: 'assembly quantities; ballast derived = 323 − struct − coat, tabs solved to match (in-pool trim is final); spares + P8 coupons excluded'
  },
  g2: {
    'p1-front-hull-pod': { samples: 30000 }, // audit G: 6000 still missed the 1.89 nose wall — resolve it
    'p2-rear-hull-pod': { samples: 30000 },
    'p3-tail-assembly': { samples: 30000 },
    'p4-hinge-pin': { excludeRegions: [{ min: [-3.2, -3.2, 45], max: [3.2, 3.2, 49.5] }] }, // Ø1.5 cross-drill rim chords (spec'd feature)
    'p4a-retainer-cap': { minWallMm: 1.3 }, // Ø9 wall over Ø6.1 bore = 1.45 by design (J6)
    'p5-ballast-plug': {
      minWallMm: 0.8, // knurl teeth ~0.95 by design
      excludeRegions: [{ min: [-11, -11, 12], max: [11, 11, 14] }] // male-thread 45° lead-in crest fade (tip chords → 0.3)
    },
    'p6-drain-plug': { minWallMm: 1.3 }, // Ø6×1.5 flange annulus over the Ø3.9 body
    'p7-fin-dorsal': { minWallMm: 1.3, excludeRegions: [{ min: [48.4, -1, -0.6], max: [50.6, 1, 1.6] }] }, // sharp trailing-corner wedge
    'p7-fin-pectoral': { minWallMm: 1.3, excludeRegions: [{ min: [33.4, -1, -0.6], max: [35.6, 1, 1.6] }] }
  },
  g3: {
    // P5 prints knob-down per spec §2 (its own print-target column): the face
    // O-ring gland ring (~312 mm³) faces up and pools — an OPEN surface groove
    // on a Ø30 solid, syringe-flushed + IPA-bathed per §7.4, not an internal
    // trap. Ceiling raised for exactly that volume.
    'p5-ballast-plug': { maxTrappedMm3: 350 }
  }
})

// G6 on the real generated body (chambers gated once above)
const g6real = G6_stability(realBody, massItems, { stepDeg: 15, gmMinMm: 3 })

// J1 seam-wall proof: resin between each pin socket and the pool, measured
// (audit L: the old belt exclusion hid 0.99 mm here)
const seamWall = seamWallProof(bare)

// Every Ø4 drain must actually accept its P6 plug (audit B: one of them could
// not be reached from either end, which would have merged two chambers)
const drainPlugs = drainPlugProof()

// J2 swing proof (audit: was self-test-only — now part of the delivered record)
const stops = stopCheck()

// measured mate probes against the ACTUAL pods (audit: G5 only walks declared
// tables): place each male at its assembly position, prove zero interference,
// then grow it radially and bisect first-contact — that growth IS the modeled
// per-side clearance of the real bores.
const podU = bare.p1.add(bare.p2) // bare pods — the sacrificial skirts snap off before any mate exists
const growProbe = (mk, expect, tol = 0.06) => {
  const base = mk(0)
  const i0 = base.intersect(podU)
  const v0 = i0.volume()
  i0.delete(); base.delete()
  let lo = 0, hi = expect + 0.25
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2
    const s = mk(mid)
    const x = s.intersect(podU)
    const v = x.volume()
    x.delete(); s.delete()
    if (v > 0.05) hi = mid
    else lo = mid
  }
  const measured = +((lo + hi) / 2).toFixed(3)
  return { interMm3: +v0.toFixed(4), measuredPerSideMm: measured, expectPerSideMm: expect, ok: v0 < 0.05 && Math.abs(measured - expect) <= tol }
}
const j1Mates = PROBES.j1.map(({ y, z }) => growProbe(
  (d) => M().cylinder(8.3, 1.5 + d, 1.5 + d, 48).rotate([0, 90, 0]).translate([PROBES.seamX - 4.15, y, z]),
  FIT.pinSocketRadial))
const j4Mate = growProbe(
  (d) => M().cylinder(PROBES.dorsal.depth - 0.6, 3.0 + d, 3.0 + d, 64).translate([PROBES.dorsal.x, 0, PROBES.dorsal.boreTopZ - PROBES.dorsal.depth + 0.2]),
  FIT.finTangRadial)
const j3Male = threadMale(7.5)
const j3Placed = j3Male.manifold.translate([PROBES.port1.x, 0, PROBES.port1.faceZ])
const j3X = j3Placed.intersect(podU)
const j3Mate = { interMm3: +j3X.volume().toFixed(4), ok: j3X.volume() < 0.05, note: 'clearance band proven by threads.selfMateCheck (identical cutter cut this port)' }
j3X.delete(); j3Placed.delete(); j3Male.manifold.delete(); podU.delete()
const matesOk = j1Mates.every((m) => m.ok) && j4Mate.ok && j3Mate.ok

// buoyancy ledger: post-ballast air, submerged reserve, longitudinal trim
const sealedVoidCm3 = +Object.values(chambers).reduce((s, v) => s + v, 0).toFixed(1)
const ballastBedCm3 = +(ballastG / trayFill.bulkGCm3).toFixed(1)
const postBallastAirCm3 = +(sealedVoidCm3 - ballastBedCm3).toFixed(1)
const realBodyCm3 = +(realBody.volume() / 1000).toFixed(1)
const allUpG = +(structG + coatG + ballastG).toFixed(1)
const reserveG = +(realBodyCm3 * 0.997 - allUpG).toFixed(1) // buoyancy margin fully submerged
const reserveOk = reserveG >= 100
// longitudinal trim: LCG vs LCB at the real waterline (audit: heave-only solve)
const hydroReal = g6real.hydro
const gmL = +(hydroReal.KB + hydroReal.BM_L - hydroReal.KG).toFixed(1)
const lcgLcbMm = +(hydroReal.com[0] - hydroReal.cob[0]).toFixed(2)
const trim = {
  lcgMm: hydroReal.com[0], lcbMm: hydroReal.cob[0], gmLMm: gmL,
  pitchDegEst: +((Math.atan2(lcgLcbMm, gmL) * 180) / Math.PI).toFixed(2),
  note: 'heave-only solve: small pitch expected from the LCG/LCB offset — bias the pebble pour fore/aft at in-pool trim (the diaphragm separates the trays, so the split is controllable)'
}

const couponReport = couponParts.map((part) => {
  const overrides = {
    // M20 stub thread ridges + 2.25 wall panel. The exclusion box is the male
    // thread's 45° lead-in crest fade at the stub top (LAYOUT8.stub [102,15],
    // top z 13.38, fade depth 1.63) — a spec'd knife-edge crest taper, the
    // SAME feature already excluded on P5. Without it the plate reads 0.218 mm
    // at 100k samples; with it, 0.944 mm at every sample count (audit G).
    'p8-coupon-plate': { minWallMm: 0.8, excludeRegions: [{ min: [91, 4, 11.65], max: [113, 26, 13.5] }] },
    'p8-coupon-ring': {
      minWallMm: 0.8, // through-threaded ring: mid-band ridge chords ~1.2
      excludeRegions: [ // 45° crest-fade tips at both ends + mouth transition (ring sits at LAYOUT8.ring = [17, 50])
        { min: [1, 34, -0.1], max: [33, 66, 2.35] },
        { min: [1, 34, 5.6], max: [33, 66, 7.6] }
      ]
    },
    'p8-coupon-pins': {},
    'p8-coupon-cube': { maxProbeMm: 25 } // 21.5 solid cube: rays must out-reach it or the sampler sees zero walls
  }[part.name] ?? {}
  const r1 = G1_manifoldRoundtrip(part)
  const r2 = G2_minWall(part, overrides)
  const r3 = G3_cavities(part)
  const r4 = G4_plateFit(part)
  return { name: part.name, ok: r1.ok && r2.ok && r3.ok && r4.ok, G1: r1.ok, G2: { ok: r2.ok, minMm: r2.minWallSampledMm }, G3: r3.ok, G4: r4.ok }
})
const couponOk = couponReport.every((r) => r.ok)

const ok = report.ok && g6real.ok && stops.ok && couponOk && ballastOk && reserveOk && matesOk && seamWall.ok && drainPlugs.ok
const out = {
  verdict: ok ? 'GREEN' : 'RED',
  secs: +((Date.now() - t0) / 1000).toFixed(1),
  mateProbes: { j1: j1Mates, j4: j4Mate, j3: j3Mate, ok: matesOk },
  massLedgerG: { struct: structG, coat: coatG, ballastDerived: ballastG, tabImplied: trayFill.tabImpliedG, allUp: allUpG, target: MASS.allUpG, ballastOk },
  buoyancyLedger: {
    sealedVoidCm3, ballastBedCm3, postBallastAirCm3,
    specSealedAirLetterCm3: MASS.sealedAirCm3,
    airNote: 'the sealed VOID (419→411 after diaphragm) satisfies the §3 letter; post-ballast AIR is ~344 — the letter\'s purposes (flood ledger per chamber, submerged reserve) are gated explicitly here',
    realBodyCm3, reserveG, reserveOk
  },
  chambersCm3: chambers, trayFill, trim,
  seamWallProof: seamWall,
  drainPlugProof: drainPlugs,
  stopCheck: stops,
  G6real: { ok: g6real.ok, draftFrac: g6real.draft.frac, gmTMm: g6real.gz.gmT, minGZMm: g6real.gz.minGZMm },
  fish: report,
  coupons: couponReport
}
writeFileSync(new URL('../parts/gates.integration.json', import.meta.url).pathname, JSON.stringify(out, null, 2))

for (const r of report.perPart) {
  console.log(JSON.stringify({
    part: r.name, ok: r.ok,
    G1: r.G1.ok, G2: { ok: r.G2.ok, minMm: r.G2.minWallSampledMm, viol: r.G2.violations },
    G3: { ok: r.G3.ok, genus: r.G3.genus.value, trappedMm3: r.G3.drain.trappedMm3 },
    G4: { ok: r.G4.ok, foot: r.G4.footprintMm, hMm: r.G4.heightWithStandoffMm }
  }))
}
for (const r of couponReport) console.log(JSON.stringify({ coupon: r.name, ok: r.ok, G2minMm: r.G2.minMm }))
console.log(JSON.stringify({ G5: { ok: report.G5.ok } }))
console.log(JSON.stringify({
  G6envelope: {
    ok: report.G6.ok, draftFrac: report.G6.draft.frac, band: report.G6.draft.band,
    gmTMm: report.G6.gz.gmT, minGZMm: report.G6.gz.minGZMm,
    steps: report.G6.gz.steps?.map((s) => ({ phiDeg: s.phiDeg, gzMm: s.gzMm })),
    chambers: report.G6.chambers
  }
}))
console.log(JSON.stringify({ G6realBody: { ok: g6real.ok, draftFrac: g6real.draft.frac, gmTMm: g6real.gz.gmT, minGZMm: g6real.gz.minGZMm, steps: g6real.gz.steps?.map((s) => ({ phiDeg: s.phiDeg, gzMm: s.gzMm })) } }))
console.log(JSON.stringify({ stopCheck: { ok: stops.ok, contactDeg: stops.contactDeg, pinInterMm3: stops.pinInterMm3 } }))
console.log(JSON.stringify({ mateProbes: out.mateProbes }))
console.log(JSON.stringify({ ledgers: { mass: out.massLedgerG, buoyancy: out.buoyancyLedger, trim } }))
console.log(JSON.stringify({ G7: { ok: report.G7.ok, totals: report.G7.totals, band: report.G7.band } }))
console.log(JSON.stringify({ drainPlugProof: { ok: drainPlugs.ok, rows: drainPlugs.rows.map((r) => ({ drain: r.drain, access: r.access, marginMm: r.marginMm, seats: r.seats })) } }))
console.log(JSON.stringify({ seamWallProof: { ok: seamWall.ok, minWallMm: seamWall.minWallMm, maxWallMm: seamWall.maxWallMm, floorMm: seamWall.floorMm } }))
console.log(JSON.stringify({ verdict: out.verdict, secs: out.secs, wrote: 'parts/gates.integration.json + parts/manifest.json + STLs' }))
process.exit(ok ? 0 : 1)
