// hydroPlus.mjs — extended hydrostatics in the GLOBAL frame (+Z up, spec §3).
// ../hydro.mjs is the proven base; its frame-agnostic pieces (volumeCentroid,
// centerOfMass — divergence-theorem integrals) are reused verbatim. hydro.mjs's
// own waterline helpers use a y-up convention; everything here is the z-up
// equivalent the spec frame needs, plus waterplane properties (area, inertia),
// the KB/BM/KM/KG composite, and the MANDATORY GZ sweep (§3: KG < KB is NOT
// achieved — stability is waterplane-borne, so §6-G6 gates on GZ>0 over
// 0–90° heel about X and GM_T > +3 mm).
// Densities/envelope/mass targets come ONLY from machine.mjs.
import { volumeCentroid, centerOfMass } from '../hydro.mjs'
import { RHO, ENVELOPE, MASS } from './machine.mjs'

export { volumeCentroid, centerOfMass }

/** water density in g/mm³ (machine.mjs RHO.water is g/cm³) */
export const RHO_W_MM3 = RHO.water / 1000

// ── waterline clips (z-up) ────────────────────────────────────────────────
/** Displaced water of the outer envelope below the plane z = waterZ.
 *  Returns {volume (mm³), centroid} and deletes the temporary manifold. */
export function submergedZ(envelope, waterZ) {
  const below = envelope.trimByPlane([0, 0, -1], -waterZ)
  const vc = volumeCentroid(below)
  below.delete()
  return vc
}

function submergedVolumeZ(envelope, waterZ) {
  const below = envelope.trimByPlane([0, 0, -1], -waterZ)
  const v = below.volume()
  below.delete()
  return v
}

/** Equilibrium waterline z for a floating body (z-up twin of hydro.mjs).
 *  Returns {waterZ, dispVolume, cob, submergedFraction} or null if it sinks. */
export function equilibriumZ(envelope, massG, { rhoWater = RHO_W_MM3, iters = 44 } = {}) {
  const bb = envelope.boundingBox()
  const total = envelope.volume()
  if (massG >= total * rhoWater) return null
  let lo = bb.min[2], hi = bb.max[2]
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2
    if (submergedVolumeZ(envelope, mid) * rhoWater < massG) lo = mid
    else hi = mid
  }
  const waterZ = (lo + hi) / 2
  const s = submergedZ(envelope, waterZ)
  return { waterZ, dispVolume: s.volume, cob: s.centroid, submergedFraction: s.volume / total }
}

// ── waterplane properties ─────────────────────────────────────────────────
/** Green's-theorem area/centroid/second moments of the z = waterZ section.
 *  Holes come back from toPolygons() negatively oriented, so the signed sums
 *  handle multi-contour sections automatically. Ixx/Iyy are CENTROIDAL. */
export function waterplaneProps(envelope, waterZ) {
  const cs = envelope.slice(waterZ)
  const polys = cs.toPolygons()
  const areaLib = cs.area()
  cs.delete()
  let A = 0, Sx = 0, Sy = 0, Ixx = 0, Iyy = 0
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i]
      const [x2, y2] = poly[(i + 1) % poly.length]
      const cr = x1 * y2 - x2 * y1
      A += cr
      Sx += (x1 + x2) * cr
      Sy += (y1 + y2) * cr
      Ixx += (y1 * y1 + y1 * y2 + y2 * y2) * cr
      Iyy += (x1 * x1 + x1 * x2 + x2 * x2) * cr
    }
  }
  A /= 2
  if (Math.abs(A) < 1e-9) return { areaMm2: 0, areaLibMm2: areaLib, centroid: [0, 0], IxxMm4: 0, IyyMm4: 0 }
  const cx = Sx / (6 * A), cy = Sy / (6 * A)
  Ixx = Ixx / 12 - A * cy * cy // centroidal, about axis ∥ x (transverse stability)
  Iyy = Iyy / 12 - A * cx * cx // centroidal, about axis ∥ y (longitudinal)
  return { areaMm2: A, areaLibMm2: areaLib, centroid: [cx, cy], IxxMm4: Ixx, IyyMm4: Iyy }
}

/** Waterplane area (mm²) at z = waterZ. */
export function waterplaneArea(envelope, waterZ) {
  return waterplaneProps(envelope, waterZ).areaMm2
}

/** Centroidal second moment of the waterplane about the longitudinal (x)
 *  axis (mm⁴) — the transverse metacentric inertia: BM_T = Ixx / V_disp. */
export function waterplaneInertiaX(envelope, waterZ) {
  return waterplaneProps(envelope, waterZ).IxxMm4
}

// ── KB / BM / KM / KG composite ───────────────────────────────────────────
/** Full upright hydrostatics ledger. massItems per hydro.mjs centerOfMass:
 *  [{manifold?|point?, massG}]. Pass {waterZ} to pin the waterline, else the
 *  equilibrium line for Σ massG is solved. All K* are mm above the keel
 *  (envelope bbox z-min). */
export function hydrostatics(envelope, massItems, { waterZ = null, rhoWater = RHO_W_MM3 } = {}) {
  const { massG, com } = centerOfMass(massItems)
  const bb = envelope.boundingBox()
  const keelZ = bb.min[2]
  const heightMm = bb.max[2] - keelZ
  let eq
  if (waterZ === null) {
    eq = equilibriumZ(envelope, massG, { rhoWater })
    if (!eq) return { floats: false, massG, note: 'mass exceeds full displacement — sinks' }
  } else {
    const s = submergedZ(envelope, waterZ)
    eq = { waterZ, dispVolume: s.volume, cob: s.centroid, submergedFraction: s.volume / envelope.volume() }
  }
  const wp = waterplaneProps(envelope, eq.waterZ)
  const KB = eq.cob[2] - keelZ
  const BM_T = wp.IxxMm4 / eq.dispVolume
  const BM_L = wp.IyyMm4 / eq.dispVolume
  const KM_T = KB + BM_T
  const KG = com[2] - keelZ
  return {
    floats: true,
    massG: +massG.toFixed(2),
    keelZ: +keelZ.toFixed(3),
    waterZ: +eq.waterZ.toFixed(3),
    draftFrac: +((eq.waterZ - keelZ) / heightMm).toFixed(4),
    dispVolMm3: +eq.dispVolume.toFixed(1),
    dispMassG: +(eq.dispVolume * rhoWater).toFixed(2),
    submergedFraction: +eq.submergedFraction.toFixed(4),
    AwpMm2: +wp.areaMm2.toFixed(1),
    IxxMm4: +wp.IxxMm4.toFixed(0),
    KB: +KB.toFixed(3),
    BM_T: +BM_T.toFixed(3),
    BM_L: +BM_L.toFixed(2),
    KM_T: +KM_T.toFixed(3),
    KG: +KG.toFixed(3),
    GM_T: +(KM_T - KG).toFixed(3),
    dTdmMmPerG: +(1 / (rhoWater * wp.areaMm2)).toFixed(4),
    cob: eq.cob.map((x) => +x.toFixed(2)),
    com: com.map((x) => +x.toFixed(2))
  }
}

// ── GZ sweep (§6-G6, MANDATORY) ───────────────────────────────────────────
/** Heel the body about +X in stepDeg increments 0→maxDeg, re-solve the
 *  equilibrium waterline at each heel, and report the righting arm
 *  GZ = horiz(CG − CB) in the heeled frame. Sign: rotating the body by +φ
 *  about +X, the −y side goes down; buoyancy torque about x is
 *  F·(y_CB − y_CG), so GZ := y_CG − y_CB is positive when the moment opposes
 *  the heel (righting). Small-angle check: GZ ≈ GM_T·sin φ.
 *  Gate: GZ > 0 at every step 0<φ≤maxDeg AND upright GM_T > gmMinMm. */
export function gzSweep(envelope, massItems, stepDeg = 15, { maxDeg = 90, gmMinMm = 3, rhoWater = RHO_W_MM3 } = {}) {
  const { massG, com } = centerOfMass(massItems)
  const upright = hydrostatics(envelope, massItems, { rhoWater })
  const steps = []
  let ok = upright.floats === true && upright.GM_T > gmMinMm
  let minGZ = Infinity
  for (let phi = 0; phi <= maxDeg + 1e-9; phi += stepDeg) {
    const rot = phi === 0 ? null : envelope.rotate([phi, 0, 0]) // degrees
    const env2 = rot ?? envelope
    const eq = equilibriumZ(env2, massG, { rhoWater })
    if (!eq) {
      steps.push({ phiDeg: phi, sinks: true })
      if (phi > 0) ok = false
      if (rot) rot.delete()
      continue
    }
    const rad = (phi * Math.PI) / 180
    const cgY = com[1] * Math.cos(rad) - com[2] * Math.sin(rad)
    const gz = cgY - eq.cob[1]
    steps.push({ phiDeg: phi, waterZ: +eq.waterZ.toFixed(2), gzMm: +gz.toFixed(3) })
    if (phi > 0) {
      minGZ = Math.min(minGZ, gz)
      if (!(gz > 0)) ok = false
    }
    if (rot) rot.delete()
  }
  return {
    ok,
    gate: `GZ>0 at every ${stepDeg}° step 0<φ≤${maxDeg}° AND GM_T>+${gmMinMm} mm (spec §3/§6-G6: KG<KB NOT achieved — sweep mandatory)`,
    gmT: upright.GM_T,
    gmMinMm,
    minGZMm: minGZ === Infinity ? null : +minGZ.toFixed(3),
    massG: +massG.toFixed(1),
    upright,
    steps
  }
}

// ── closed-form ellipsoid cross-checks (spec §3 chain) ────────────────────
export const ellipsoidAnalytic = {
  vEnv: (a = ENVELOPE.a, b = ENVELOPE.b, c = ENVELOPE.c) => (4 / 3) * Math.PI * a * b * c,
  /** waterline z for a draft fraction x of total height */
  waterZ: (x, c = ENVELOPE.c) => c * (2 * x - 1),
  /** displaced volume at draft fraction x — exact: V_env·x²(3−2x) */
  vDisp: (x, a = ENVELOPE.a, b = ENVELOPE.b, c = ENVELOPE.c) =>
    ellipsoidAnalytic.vEnv(a, b, c) * x * x * (3 - 2 * x),
  waterplaneArea: (z, a = ENVELOPE.a, b = ENVELOPE.b, c = ENVELOPE.c) =>
    Math.PI * a * b * (1 - (z / c) ** 2),
  /** centroidal waterplane Ixx (about the longitudinal axis) */
  waterplaneIxx: (z, a = ENVELOPE.a, b = ENVELOPE.b, c = ENVELOPE.c) =>
    (Math.PI / 4) * a * b ** 3 * (1 - (z / c) ** 2) ** 2,
  /** KB above keel for waterline z (independent of a, b) */
  KB: (z, c = ENVELOPE.c) => {
    const I0 = (z - z ** 3 / (3 * c * c)) + (c - c / 3)
    const I1 = (z * z / 2 - z ** 4 / (4 * c * c)) - (c * c) / 4
    return I1 / I0 + c
  },
  /** all-up mass band (g) over a draft-fraction band, at RHO.water */
  massBand: (fracLo, fracHi) => [
    RHO_W_MM3 * ellipsoidAnalytic.vDisp(fracLo),
    RHO_W_MM3 * ellipsoidAnalytic.vDisp(fracHi)
  ]
}

// ── self-test ─────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const { boot, M } = await import('../lib.mjs')
  await boot()
  const Manifold = M()
  let allOk = true
  const check = (name, ok, detail) => {
    allOk &&= ok
    console.log(JSON.stringify({ check: name, ok, ...detail }))
  }
  const near = (v, ref, relTol) => Math.abs(v - ref) <= Math.abs(ref) * relTol

  // ── reference solid 1: box 60×40×30, centered (analytic everything) ─────
  const box = Manifold.cube([60, 40, 30], true)
  const boxMassHalf = 60 * 40 * 30 * RHO_W_MM3 / 2 // floats at exactly half draft
  {
    const A = waterplaneArea(box, 0)
    const Ixx = waterplaneInertiaX(box, 0)
    const refA = 60 * 40, refI = (60 * 40 ** 3) / 12
    check('box-waterplane', near(A, refA, 1e-3) && near(Ixx, refI, 1e-3),
      { AwpMm2: +A.toFixed(1), refA, IxxMm4: +Ixx.toFixed(0), refI })
  }
  {
    const eq = equilibriumZ(box, boxMassHalf)
    check('box-equilibrium-halfdraft', Math.abs(eq.waterZ) < 0.05 && Math.abs(eq.submergedFraction - 0.5) < 0.005,
      { waterZ: +eq.waterZ.toFixed(3), submergedFraction: +eq.submergedFraction.toFixed(4) })
  }
  const boxItemsMid = [{ point: [0, 0, 0], massG: boxMassHalf }] // KG = 15
  {
    const h = hydrostatics(box, boxItemsMid)
    // analytic: KB 7.5, BM 320000/36000 = 8.8889, KM 16.3889, KG 15, GM 1.3889
    const okv = near(h.KB, 7.5, 0.01) && near(h.BM_T, 8.8889, 0.01) &&
      near(h.KG, 15, 0.001) && Math.abs(h.GM_T - 1.3889) < 0.03
    check('box-KB-BM-KM-KG', okv, { KB: h.KB, BM_T: h.BM_T, KM_T: h.KM_T, KG: h.KG, GM_T: h.GM_T, analytic: { KB: 7.5, BM: 8.8889, GM: 1.3889 } })
  }
  {
    // wall-sided exact GZ at 15°: sinφ·(GM + ½·BM·tan²φ) = 0.4420 (edges stay dry: tan15 < 2(D−T)/B)
    const sw = gzSweep(box, boxItemsMid, 15, { maxDeg: 15 })
    const gz15 = sw.steps[1]?.gzMm
    const ref = Math.sin(Math.PI / 12) * (1.38889 + 0.5 * 8.88889 * Math.tan(Math.PI / 12) ** 2)
    check('box-GZ-wallsided-15deg', gz15 !== undefined && Math.abs(gz15 - ref) < 0.02,
      { gz15Mm: gz15, analyticMm: +ref.toFixed(4), note: 'sign convention proven: +GZ = righting' })
  }
  {
    // bottom-heavy box: KG=1 → GM = 15.389 > 3, GZ>0 through 0–90° — full gate demo
    const items = [{ point: [0, 0, -14], massG: boxMassHalf }]
    const sw = gzSweep(box, items, 15)
    check('box-lowCG-gzSweep-gate', sw.ok === true && sw.gmT > 3 && sw.minGZMm > 0,
      { gmT: sw.gmT, minGZMm: sw.minGZMm, steps: sw.steps })
  }

  // ── reference solid 2: the spec envelope ellipsoid (machine.mjs dims) ───
  const { a, b, c, waterlineFrac } = ENVELOPE
  const ell = Manifold.sphere(c, 128).scale([a / c, b / c, 1])
  {
    const v = ell.volume()
    check('ellipsoid-volume', near(v, ellipsoidAnalytic.vEnv(), 0.005),
      { volCm3: +(v / 1000).toFixed(1), analyticCm3: +(ellipsoidAnalytic.vEnv() / 1000).toFixed(1) })
  }
  const z55 = ellipsoidAnalytic.waterZ(waterlineFrac) // +3.5 (spec §3 design waterline)
  {
    const A = waterplaneArea(ell, z55)
    const Ixx = waterplaneInertiaX(ell, z55)
    check('ellipsoid-waterplane-at-0.55', near(A, ellipsoidAnalytic.waterplaneArea(z55), 0.005) &&
      near(Ixx, ellipsoidAnalytic.waterplaneIxx(z55), 0.01),
      { AwpMm2: +A.toFixed(0), analyticA: +ellipsoidAnalytic.waterplaneArea(z55).toFixed(0),
        IxxMm4: +Ixx.toFixed(0), analyticIxx: +ellipsoidAnalytic.waterplaneIxx(z55).toFixed(0) })
  }
  {
    const eq = equilibriumZ(ell, MASS.allUpG)
    const frac = (eq.waterZ + c) / (2 * c)
    check('ellipsoid-323g-floats-at-0.55', Math.abs(frac - waterlineFrac) < 0.01,
      { draftFrac: +frac.toFixed(4), waterZ: +eq.waterZ.toFixed(2), dispCm3: +(eq.dispVolume / 1000).toFixed(1) })
  }
  // demo mass ledger (spec §3 numbers): hull structure+coat at the geometric
  // center (z=0), ballast MASS.ballastNominalG at z_b = 15.75 above keel
  // (spec §3/§8 row 13: z_b ≈ 15.5–16). KG ≈ 27.1, KM ≈ 30.7 → GM ≈ +3.6.
  const ZB_KEEL = 15.75 // spec §3 ballast centroid above keel (not a machine.mjs number)
  const fishItems = [
    { point: [0, 0, 0], massG: MASS.allUpG - MASS.ballastNominalG }, // shell+bosses+coat stand-in
    { point: [0, 0, ZB_KEEL - c], massG: MASS.ballastNominalG }
  ]
  {
    const h = hydrostatics(ell, fishItems)
    const okv = near(h.KB, ellipsoidAnalytic.KB(h.waterZ), 0.01) &&
      near(h.BM_T, ellipsoidAnalytic.waterplaneIxx(h.waterZ) / h.dispVolMm3, 0.01) &&
      h.dTdmMmPerG >= 0.083 && h.dTdmMmPerG <= 0.086 && // spec §8 row 18
      Math.abs(h.KM_T - 30.7) < 0.4 // spec §8 row 14 (KB 23.8 + BM 6.9 at 0.55)
    check('ellipsoid-KB-BM-KM-vs-spec', okv, {
      KB: h.KB, analyticKB: +ellipsoidAnalytic.KB(h.waterZ).toFixed(3),
      BM_T: h.BM_T, KM_T: h.KM_T, specKM: 30.7, KG: h.KG, GM_T: h.GM_T,
      dTdmMmPerG: h.dTdmMmPerG, specBand: [0.083, 0.086]
    })
  }
  {
    const sw = gzSweep(ell, fishItems, 15)
    check('ellipsoid-G6-gzSweep-gate', sw.ok === true && sw.gmT > 3 && sw.minGZMm > 0,
      { gmT: sw.gmT, minGZMm: sw.minGZMm, steps: sw.steps })
  }
  {
    const band = ellipsoidAnalytic.massBand(0.40, 0.60)
    check('mass-band-40-60', Math.abs(band[0] - 198) < 1 && Math.abs(band[1] - 365) < 1,
      { bandG: band.map((x) => +x.toFixed(1)), specBandG: [198, 365] })
  }

  box.delete(); ell.delete()
  console.log(JSON.stringify({ verdict: allOk ? 'GREEN' : 'RED', module: 'hydroPlus.mjs' }))
  process.exit(allOk ? 0 : 1)
}
