# Fish generator — module contracts (READ FIRST, then BUILD-SPEC.md)

Everything below is binding. The spec is `../BUILD-SPEC.md`. The proven base
library is `../lib.mjs` (loft/ellipseRing/writeSTL/validate) and `../hydro.mjs`
(volumeCentroid/submerged/equilibrium). `../fish.mjs` is an OBSOLETE draft —
ignore it entirely. Deps are installed in `../node_modules` (manifold-3d,
three, playwright NOT here — no rendering in modules).

## Global frame (mm)
- **+X longitudinal**, nose apex at x = −140, envelope tail at +140.
  Sealed hull = pods P1 (−140…−20) and P2 (−20…+100). Tail P3 occupies
  +100…+160 (free-flooding; overall fish ≈ 300).
- **+Z up.** Envelope half-height c = 35 (z ∈ −35…+35). Design waterline
  z = +3.5 (0.55 of height). Belly features at −z.
- **+Y lateral**, half-width b = 27.5.
- Envelope: ellipsoid a=140 (x), b=27.5 (y), c=35 (z). Section at x:
  scale = sqrt(max(0, 1 − (x/a)²)); ry = b·scale, rz = c·scale.
- Print orientation is DECLARED per part in its module (pods upright = X
  vertical); geometry stays in the global frame — orientation is metadata
  `printOrientation: {up:[…], note}` returned alongside the manifold.

## machine.mjs (provided)
`import { FIT, PLATE, RHO, WALL } from './machine.mjs'` — the ONLY source of
clearances/plate/densities/walls. Never hardcode a number that exists there.

## Module contract
Each module is ESM, exports named builder functions returning
`{ name, manifold, printOrientation, meta }` (meta: expected chamber volumes,
mating features, etc.). Each module ends with a self-test block:
```js
if (import.meta.url === `file://${process.argv[1]}`) { /* build, gate, print JSON, writeSTL to ../parts/ */ }
```
Self-tests MUST run green (`node src/<mod>.mjs`) before you finish: gates =
lib.validate + spec §6 checks you can apply locally (G1 manifold, G4 plate fit
in the declared orientation, sealed-cavity genus rule G3: `-genus() === 0`
for printed parts; free-flooded/vented parts explain their expected genus in
meta). Print a one-line JSON verdict per part.

## Memory discipline (spec §5)
Every intermediate Manifold in loops gets `.delete()` where practical; chained
temporaries are acceptable in one-shot builders, forbidden inside retry loops.

## Boolean/api gotchas (proven in-sandbox)
- `await Module()` then `wasm.setup()` once — lib.mjs boot() does this.
- `Manifold.cylinder(height, rLow, rHigh?, segments)` extrudes +Z from z=0;
  `.rotate([degX, degY, degZ])` takes DEGREES; `.translate([x,y,z])`.
- `CrossSection([[…points]]).extrude(h, nDiv?, twistDeg?, scaleTop?)` —
  twist-extrude is how threads are made (threads.mjs proves it).
- `manifold.status()` stringifies 'NoError'; construction never throws —
  always check. `volume()`, `surfaceArea()`, `genus()`, `boundingBox()` exist.
- STL: `writeSTL(manifold, path, name)` from lib.mjs (binary, verified).

## Who builds what
- `threads.mjs` — M20×2.5 male/female formers per spec J3/§5 (+0.15 radial on
  female), crest/root r≥0.3 approximated by profile fillets, 45° lead-in,
  7.5 mm / 3-turn engagement; exports `threadMale(lengthMm)`,
  `threadFemaleCutter(lengthMm)` (a solid to SUBTRACT), plus
  `selfMateCheck()` proving male ∩ femaleCutter-complement clearance ≥ 0.05.
- `pods.mjs` — P1 and P2-body (P2 WITHOUT clevis; import `clevisFork()` and
  union it) per spec §2 rows P1/P2: hull loft (14 stations), 2.25 shell,
  trims at x=−20/+100, J1 flange+nubs+groove+moat+chamfer+3 asymmetric pin
  sockets, bulkheads at x=−80/+40 with Ø4 drains, Ø3 shell vents, M20 port
  bosses (threads.mjs female cutter), ballast trays with depth stops at
  z_b≈−19 (centroid 15.5–16 above keel), fin sockets w/ Ø2 drains, 2×1 skirt
  ring (0.3 web) at the rim.
- `tailparts.mjs` — `clevisFork()` (for P2: 2 knuckles Ø6.5 bore, wall 3.0,
  span 40–45, ±30° stops, r≥1 fillets), P3 tail (1.8 peduncle mini-loft, 2.5
  blade w/ lens sections + 3–4 root fillet, central knuckle, 2×Ø3 flood low
  + Ø2 vent high — STAY OPEN), P4 printed pin fallback (Ø6×50, head Ø9×2) +
  P4a retainer caps (Ø9×6, blind Ø6.1×4).
- `smallparts.mjs` — P5 ballast plug (threads.mjs male, knurl≈polygon grip,
  face O-ring gland 1.5 deep × 2.7 wide at gland ID 21–22), P6 tapered drain
  plugs (Ø3.9, 2° taper, Ø6 flange), P7 fins (1.5 blade + Ø6 tang), P8 coupon
  plate exactly per spec row P8 (3 socket classes, 3 clevis bores, M20 ring
  pair, 3 loose pins, 21.5 mm density cube, 2.25 wall panel).
- `gates.mjs` — §6 G1–G7 as callable checks over `{name, manifold,
  printOrientation, meta}` lists + the joint table J1–J6 clearance walker +
  min-wall sampler (normal-ray sampling ≥2.0) + mass manifest builder;
  `hydroPlus.mjs` — extend ../hydro.mjs: waterplane area & inertia at a given
  z, KB/BM/KM/KG composite, and `gzSweep(envelope, massItems, stepDeg=15)`
  rotating about X, re-clipping, righting arm horiz(CB−CG); gate: GZ>0 at
  every step 0–90°, GM_T>+3.
