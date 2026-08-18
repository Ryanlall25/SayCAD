// The single source of machine truth (spec §5 machine.js). Coupon results
// rewrite THIS file (fit table), never the geometry modules.
export const PLATE = {
  usable: [120, 72, 145], // conservative Photon Mono-class after margins
  hardGate: 'Confirm Mono-class machine (130×80×165). Original Photon (115×65) FAILS the pods.'
}

export const RHO = {
  resin: 1.15, // g/cm3 — ABS-like; replace with weighed 10 mL coupon cube value
  water: 0.997,
  ballastBulk: 1.8 // glass pebble + epoxy pour
}

export const WALL = {
  hull: 2.25,
  hullFloor: 2.0,
  boss: 3.0,
  peduncle: 1.8,
  blade: 2.5,
  fin: 1.5
}

export const FIT = {
  // radial / per-side, mm — female side carries the clearance (spec §4)
  pinSocketRadial: 0.15, // Ø3.0 pin → Ø3.3 socket
  hingeRadial: 0.25, // Ø6.0 pin → Ø6.5 bore
  threadFemaleRadial: 0.15, // M20×2.5
  finTangRadial: 0.15, // Ø6.0 tang → Ø6.3 socket
  drainTaperDeg: 2, // Ø3.9 plug in Ø4.0 hole
  bondlineNub: 0.2, // J1 standoff nubs height
  minTestableRadial: 0.05 // below this → ERROR, coupon required (G5)
}

export const ENVELOPE = { a: 140, b: 27.5, c: 35, waterlineFrac: 0.55 }
export const CUTS = { p1p2: -20, hullTail: 100 } // x planes
export const MASS = { allUpG: 323, coatBudgetG: 30, ballastNominalG: 132, sealedAirCm3: 382 }
