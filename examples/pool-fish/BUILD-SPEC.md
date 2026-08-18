# Fish Prototype — Build Specification v1

**Scope.** Decorative wave-wagging pool fish, MSLA resin, Anycubic Photon-class printer (assumed **Photon Mono-class, 130 × 80 × 165 mm** — **HARD GATE: confirm machine model; an original Photon/Photon S at 115 × 65 mm cannot print the hull pods**). Planning usable volume after margins: **120 × 72 × 145 mm**. All dimensions mm, masses g, ρ_water = 0.997 g/cm³.

---

## 1. Design decisions

| # | Decision | Justification (discovery citation) |
|---|----------|-----------------------------------|
| D1 | **Resin: ABS-like tough methacrylate** — Anycubic ABS-Like Resin Pro 2 (subs: Siraya Tech Blu, Elegoo ABS-Like 3.0), opaque pigmented. **Engineering density ρ = 1.15 g/cm³** (band 1.10–1.20, verified). **Water-washable resin BANNED.** | resin-water: 35–40 % elongation / 212 J/m Izod survives hinge, handling, thermal cycling; standard resin (2–6 % elong.) and water-washable (~2 %+/24 h uptake, cracking) both fail immersion service. MSLA is 100 % dense — no FDM infill discount. |
| D2 | **Hollow-shell strategy: monolithic open-rim vented pods, sealed at assembly** (drain-hole doctrine), **not** glued clamshell halves. Each hull pod prints as one hollow shell with its **open mating rim toward the plate on a modeled break-away skirt** (cavity vents through the 5–6 mm support standoff — no cupping); the two sub-chambers that are closed in print orientation each get an explicit drain pair, plugged + epoxied after post-cure. | hydrostatics (high conf., verified): monolithic pods collapse the build to **one wet hull seam**; print-plan: open-rim-down orientation removes the cupping/trapped-resin failure that motivated the clamshell, at half the seam count and part count; resin-hollow's drain-hole spec (≥2 holes, Ø3–4, tapered plugs) is retained for the closed sub-chambers. Never model a print-sealed cavity (all reports). |
| D3 | **Length: 240 mm sealed hull + 60 mm hinged free-flooding tail ≈ 300 mm overall.** Hydrostatic envelope = ellipsoid 280 × 55 × 70 (a=140, b=27.5, c=35). | hydrostatics: all verified displacement/stability numbers derive from this ellipsoid; flooded-tail displacement loss (~13 g at waterline) is inside the trim budget. Deviation from tail-dynamics' 63–68 % hinge station is deliberate — see §4 joint J2 note. |
| D4 | **Segment count: 2 hull pods (120 mm each) + tail** — cut planes at x = −20 and x = +100 from mid-length. | hydrostatics (verified): segments 222 + 311 cm³, both pods fit the plate **upright** (footprint 55 × 70, height ≤130 incl. clevis, ≤145 usable Z); one glued seam instead of the FDM 9-part build. |
| D5 | **Design waterline x = 0.55 of height** (draft 38.5, all-up **323 g**). | hydrostatics: centers the 40–60 % band asymmetrically (+42 / −125 g margin), GM ≈ +4–5 mm; trim is set in-pool, absorbing the ±0.05 density band. |
| D6 | **Clearance baseline: hobby-MSLA wet-service band 0.15–0.35 mm/side; hinge 0.25 mm radial; press fits BANNED in resin; every fit gated by a coupon plate printed first.** | joints-resin (verified): §3.4 SLA press row deleted (brittle hoop cracking); XY blooming on uncalibrated exposure eats 0.05–0.15 mm diametral — RERF calibration + coupon are mandatory gates. |
| D7 | **Walls: 2.25 mm hull nominal (floor 2.0), 3.0 mm at all bosses/lugs/ports, 1.8 mm tail peduncle, 2.5 mm caudal blade, 1.5 mm decorative fins.** | resin-water (verified): hoop stress at ±10–15 kPa breathing is ~175 kPa vs 40–60 MPa — handling/impact governs, not pressure; blade thickened from the FDM 0.8–1.2 membrane (tail-dynamics). |
| D8 | **Adhesive system: West System G/flex 650/655 epoxy (structural, sole), printer UV resin as tack/fillet/plug glue, neutral-cure RTV gasket-only. CA, solvent cements, PU glues BANNED.** | adhesives-seal (verified): G/flex is TDS-rated for plastics + immersion; CA hydrolyzes and releases in weeks underwater — the likeliest field failure. |
| D9 | **Mandatory UV topcoat** (epoxy fillet on seams/plugs as primer → exterior UVA/HALS clear: spar/2K aliphatic urethane or UV-resistant acrylic), annual recoat. Coating's job = UV screen + seam seal, **not** bulk waterproofing (resin walls are monolithic). | resin-water (verified): Florida sun yellows in 2–6 weeks, embrittles ABS-like toward <10 % elongation in 2–6 months; FDM §7.4 porosity seal deleted for resin. |

---

## 2. Part list

Print target: **resin plate** for everything printed unless noted. All resin parts in ABS-like resin.

| ID | Name | Qty | Bounding (mm) | Wall (mm) | Print target | Special features |
|----|------|-----|---------------|-----------|--------------|------------------|
| P1 | Front hull pod (nose → x=−20) | 1 | 120 × 55 × 70 | 2.25 (3.0 bosses) | resin, upright, open rim down on skirt | Nose dome; integral bulkhead at x=−80 with Ø4.0 drain hole; Ø3.0 shell vent (belly, near nose); aft **seam flange** (see J1); 3 asymmetric pin sockets Ø3.3 × 4.5; M20×2.5 female belly port + boss (wall 3.0); ballast tray 60 mm with printed depth stop; dorsal-fin socket Ø6.3 × 12 blind + Ø2 drain, boss wall 3.0; break-away skirt ring 2 × 1, 0.3 web |
| P2 | Mid/rear hull pod (x=−20 → +100) | 1 | 130 × 55 × 70 (incl. clevis) | 2.25 (3.0 bosses) | resin, upright, open rim down on skirt | Front seam flange (mate of J1) + pin sockets Ø3.3 × 4.5; integral bulkhead at x=+40 with Ø4.0 drain hole; Ø3.0 shell vent near peduncle; **clevis fork** aft: 2 knuckles, bore Ø6.5, knuckle wall 3.0, vertical span 40–45, ±30° stops with ≥3×3 chamfered faces (r≥1 root fillets); M20×2.5 belly port; ballast tray 60 mm + depth stop; 2× pectoral fin sockets Ø6.3 × 10 blind + Ø2 drains; skirt ring |
| P3 | Tail assembly (peduncle + caudal blade) | 1 | 60 × 12 × 80 | peduncle 1.8; blade 2.5, root fillet 3–4 | resin, blade near-vertical (~75°), supports on root/leading edge only | **Free-flooding**: 2× Ø3.0 flood holes low/aft + 1× Ø2.0 vent high (STAY OPEN); single central knuckle, bore Ø6.5; blade planform ~45 × 75, lens section, edge radius ≥0.6; dry mass target 25–40 g, flooded submerged weight +1…+5 gf |
| P4 | Hinge pin | 1 (+1 spare) | Ø6.0 × 50 | solid | **cut Ø6 mm HDPE rod (purchased)**; fallback: printed ABS-like, vertical, integral head Ø9×2 + Ø1.5 cross-drill | Retention: 2× printed caps P4a Ø9 × 6, blind bore Ø6.1 × 4, neutral-cure silicone dab (serviceable). No snap features, no cap nut (deleted per verification) |
| P5 | Ballast plug | 2 (+1 spare) | Ø30 × 14 | solid | resin, thread axis vertical, knob down | M20×2.5 male, 7.5 mm / 3-turn engagement, crest/root radii ≥0.3, 45° lead-in; knurled Ø30 grip; **face O-ring gland 1.5 deep × 2.7 wide at gland ID 21–22 for EPDM 21×2 (or 22×2) cord, ~25 % squeeze** (corrected from 18×2); hand-tight to shoulder only |
| P6 | Tapered drain plug | 4 + 4 spares | Ø6 × 6 | solid | resin, either plate | Ø3.9 body, 2° taper, Ø6 flange; bedded in UV resin (60–90 s flash), epoxy skim over |
| P7 | Fins: dorsal ×1, pectoral ×2 | 3 | dorsal ~50 × 30; pect. ~35 × 20 | 1.5 | resin (FDM PETG acceptable — then epoxy-only bonding) | Cylindrical tang Ø6.0 × 10 (dorsal 12), epoxied into P1/P2 sockets (0.15/side) |
| P8 | Coupon plate | 1 | 62 × 30 × 12 (+ cube) | — | resin, **printed FIRST**, same tilt/exposure/layer as production | Row A: Ø3.0-pin sockets Ø3.2/3.3/3.4 blind ×4.5 + Ø2 drains; Row B: clevis bores Ø6.3/6.5/6.7 through 8 mm lugs, axes in production orientation; Row C: M20×2.5 male+female rings at +0.15 mm radial; loose 3× Ø3.0×12 pins; **10 mL density cube (21.5 mm)** for weighing; wall coupon panel 2.25 |

Consumables: G/flex 650 (655 for gaps), 405 nm UV torch ~5 W, EPDM 21×2 O-rings ×3, pool-grade silicone grease (Magic Lube II / Molykote 111 class), neutral-cure RTV, ≥95 % IPA, 220-grit + glass plate, exterior UV clear. Resin budget ≈ 200–250 mL incl. supports.

---

## 3. Hydrostatics contract

The generator MUST reproduce this chain parametrically (a=140, b=27.5, c=35, t=2.25, ρ_resin=1.15, ρ_w=0.997 as free parameters), then supersede the estimates with mesh integrals:

```
V_env      = (4/3)·π·a·b·c                        = 564.4 cm³
V_disp(x)  = V_env · x²(3−2x)          (exact for ellipsoid; x = draft/height)
m_allup    = ρ_w · V_disp(0.55)                    = 323 g   (band 198–365 g over x=0.40–0.60)
V_shell    = uniform-offset shell (Steiner: S·t − M·t² + (4π/3)t³) = 94.6 cm³ at t=2.25
             (NOT the scaled-inner-ellipsoid 87.3 cm³ — that thins flanks to ~1.65 mm; corrected)
m_struct   = (94.6 + extras 28–40 + fins/tail 25) cm³ · ρ   = 176 g nominal (band 151–203)  ← corrected from 168
m_coat     = 10–25 g computed, budget 30 g (corrected from 15–30; weigh after coating)
m_ballast  = m_allup − m_struct − m_coat           ≈ 132 g nominal (final value set by in-pool trim)
KB(x)      : closed form KB(0.5)=5c/8=21.9;  at x=0.55: KB=23.8, BM_T=3b²/8c-family → 6.9, KM_T=30.7
KG         = (m_struct·36 + m_ballast·z_b)/m_total,  z_b ≈ 15.5–16 (corrected — 11–13 is geometrically impossible at 1.8 g/cm³)
GM_T       = KM_T − KG ≈ +4…+5 mm at x=0.55   (corrected from +6.2; band +3…+5 across 50–60 %)
dT/dm      = 1/(ρ_w·A_wp) = 0.083–0.086 mm/g  (~12 g per mm of draft)
```

**Air/ballast ledger at design point:** internal cavity 477 cm³; sealed air required **382 cm³ = 68 % of envelope = 80 % of cavity**. Four chambers ≈ 80/79/112/111 cm³ (F1/F2/M1/M2; generator recomputes from mesh). Ballast: **glass pebbles/coarse silica in epoxy, bulk ≈1.8 g/cm³ (~73 cm³ at 132 g), NO metal**, two 60 mm belly trays straddling the mid-seam, poured through the M20 ports after in-pool dry trim, then epoxy-flooded. Flood tolerance: 41 g stays in the 40–60 % band; worst single-chamber flood (112 cm³) still floats at 69 % height; 239 g to decks-awash. Reserve buoyancy fully submerged: 2.35 N.

**CoM-below-CoB margin: NOT achieved** — verification shows KG > KB across the whole 50–60 % band (KG ≈ 26.3–26.6 vs KB 25.7 even at 60 %). Stability is waterplane-borne (GM_T > 0) plus inverted-instability (GM inverted ≈ −15 mm). **Therefore the GZ sweep gate (§6-G6) is mandatory, not optional.**

---

## 4. Joints & assembly

### Joints (clearances are radial/per-side as noted; female side carries the clearance)

| ID | Joint | Clearance | Spec |
|----|-------|-----------|------|
| J1 | **Hull seam** P1↔P2 (only glued wet seam) | bondline 0.2 mm via 3 standoff nubs; pins 0.15 mm/side | Flat annular flange 5 wide (following ellipse section at x=−20), three 0.2 mm-high standoff nubs, glue groove 1.0 × 0.5 mid-flange, inner squeeze-out moat 1.0 × 0.5, outer 0.4 × 45° witness chamfer; 3× Ø3.0 pins in Ø3.3 × 4.5 sockets, **asymmetric pattern** (mis-assembly geometrically impossible). Flanges sanded flat on 220-grit over glass before glue-up. Seam stress margin >20× at ±15 kPa breathing (verified). |
| J2 | **Tail hinge** (vertical axis, plumb ±2°) | **0.25 mm radial nominal, band 0.15–0.40** | Ø6.0 pin in Ø6.5 bores; body fork (2 knuckles) + tail central knuckle; span 40–45; domed lower thrust face r≈1.5; stops ±30°, ≥3×3 chamfered faces, optional 1 mm RTV pads; body–tail axial gap 1.5–2.0; bores and pin stay **unpainted**; hand-ream bores with a Ø6.0 drill after cure. Friction budget ≤0.1 mN·m breakaway (reject >0.3); acceptance: 1 g on a thread at 20 mm radius must turn the tail. *Note: hinge sits at the peduncle face (240 mm from nose), aft of tail-dynamics' 63–68 % station — chosen to preserve the verified hydrostatics segmentation; blade moment arm ~30–35 mm keeps wave torque ≥4–10× friction. Wag amplitude ±5–15° in 5–15 mm chop (validate at pool test).* |
| J3 | **Ballast ports** ×2 | thread: +0.15 mm radial on female only (validate with coupon row C) | M20×2.5, 3 turns; seal is the **face O-ring** (EPDM 21×2, gland 1.5 × 2.7, ID 21–22, ~25 % squeeze), never the threads; silicone pool grease on ring + threads; PTFE tape BANNED; hand-tight to shoulder. |
| J4 | **Fin tangs** ×3 | 0.15 mm/side epoxy fit | Ø6.0 tang in Ø6.3 blind socket, Ø2 drain at socket floor, G/flex bonded. |
| J5 | **Drain plugs** ×4 | tapered (2°), Ø3.9 body in Ø4.0 hole | Wetted with printer UV resin, flashed 60–90 s in 2–3 passes (cure depth in pigmented resin only ~0.3–1 mm — corrected), epoxy skim over during fillet pass. |
| J6 | Pin retainer caps ×2 | Ø6.1 blind bore on Ø6.0 pin (snug) | Neutral-cure silicone dab; serviceable for pin replacement. |

### Assembly order (each step gates the next)

1. RERF/exposure calibration print → freeze exposure/AA/lift for the whole project.
2. **Print P8 coupon plate.** Pick classes: registration = tightest that thumb-seats and withdraws tool-free; hinge = one class looser than free-spinning; thread pair must run on by hand. Weigh the 10 mL cube → measured ρ. Coupon results rewrite the machine-profile fit table (not the geometry).
3. Print production plates (P1, P2 upright on skirts; P3/P5/P6/P7 small plate).
4. Post-process every part: drain in-vat 10–15 min tilted; two-bath ≥95 % IPA ≤5 min total with syringe-flush of chamber interiors, grooves, blind sockets; air-dry 30–60 min; **405 nm post-cure 15–30 min rotating, warm 40–60 °C, ALL HOLES OPEN**; optional final pass submerged in water (kills the oxygen-inhibited tacky layer). Snap skirts off after cure.
5. Weigh every part on a 0.1 g scale; record against the mass budget (§6-G7). Hand-ream Ø6.5 bores.
6. Dry-fit everything: seam on pins, tail on pin, plugs with O-rings.
7. Seal F1 and M2 drain holes (interiors finished): tapered plugs per J5. Ballast chambers F2/M1 keep their M20 ports as permanent access.
8. Bond hull seam J1: sand flat, scuff 80–120 grit, IPA wipe, G/flex bead in groove, mate on pins to nub contact, tape-clamp **24 h**.
9. **Per-hull leak test:** submerge bonded hull 24 h at ~0.3 m; PASS = mass gain <0.5 g (no pre-soak baseline needed on resin).
10. Epoxy fins (J4); external epoxy fillet band 8–10 mm over the seam and all plugs.
11. Mask hinge bores, pin, threads, O-ring gland faces → UV topcoat (2 coats).
12. Fit tail: insert pin, silicone-dab retainer caps.
13. **Cure gates:** 72 h after last epoxy at ≥24 °C (7 days below ~18 °C); 48–72 h after RTV; topcoat per TDS — all before water.
14. In-pool ballast trim (see §7).

**Adhesive cure data (G/flex, 22 °C):** working 45 min; solid 3–4 h; workable 7–10 h; full strength 24 h (spec 1–2 days); immersion at +72 h.

---

## 5. Geometry-code plan

Node ESM, `manifold-3d@3.5.1` + `three@0.185.1` (both PROVEN in-sandbox). Module breakdown:

- **`machine.js`** — plate limits (120×72×145 usable), the coupon-rewritable fit table (JSON), ρ_resin (updated from the weighed cube). Compensation applied in exactly ONE place (geometry, not slicer).
- **`hull.js`** — station table for the 280×55×70 ellipsoid re-sampled at ~12–16 stations over the sealed 240 mm; `loftHull()` and the float64 signed-volume winding guard, verbatim from the proof:

```js
const wasm = await Module();  wasm.setup();          // MANDATORY or Manifold is undefined
const { Manifold, Mesh } = wasm;
// ... loftHull(stations, apexX): apex fan (apex, k+1, k); quads (A,B,D)+(B,C,D); rear fan (center, k, k+1)
const m = Manifold.ofMesh(mesh);
if (m.status() !== 'NoError') throw new Error(...)   // ofMesh NEVER throws — it returns an empty Manifold
```

- **`shell.js`** — inner loft with per-station semi-axis inset (b−t, c−t) and x-range inset, `outer.subtract(inner)`. Known ~1 % thinning at 45° per section (acceptable); the longitudinal-taper thinning near nose/peduncle is caught by G2. (Exact-wall upgrade path: `Manifold.levelSet` or per-section Clipper2 offset.)
- **`segment.js`** — `hull.trimByPlane()` / `splitByPlane()` at x=−20 and x=+100; flange builder (annular extruded ring + 3 nub cylinders 0.2 h + groove/moat ring cuts + chamfer), sockets via `Manifold.cylinder(depth, r).translate(...)` — `cylinder(h, rLo, rHi?, segs, center?)` extrudes +Z from z=0; `rotate()` takes **degrees**.
- **`features.js`** — bulkheads (extruded elliptical discs ∪ pod, minus Ø4 drain), belly-port bosses, ballast trays + depth stops, shell vents. **M20×2.5 threads via twist-extrude:** `Manifold.extrude(threadProfilePolygon, 7.5, nDiv, twistDegrees = 3*360)` for male/female forms with +0.15 radial female offset, crest/root r≥0.3 **(validate with coupon row C — thread form by twist-extrude is standard practice but unproven in this sandbox)**.
- **`clevis.js`** — fork/knuckle solids (cylinders + boxes, r≥1 fillets via minkowski-style union of rounded profiles), Ø6.5 bores, ±30° stop faces.
- **`tail.js`** — peduncle mini-loft (1.8 wall) + blade loft (2.5, lens sections, 3–4 root fillet) + knuckle; flood holes (these stay open — expected `genus()` reflects vented topology).
- **`fins.js`**, **`coupon.js`** (P7, P8 as specced), **`ballastplug.js`** (P5 incl. gland ring cut).
- **`hydro.js`** — waterline clip via `trimByPlane` at z = 0.55·70: displaced volume, waterplane area (dT/dm), buoyancy centroid (KB), BM via waterplane inertia, composite KG from per-part `volume()`·ρ + ballast; **GZ sweep**: rotate assembly in 15° heel steps 0→90°, re-clip, righting arm = horiz(CB−CG).
- **`export.js`** — verbatim from proof: extract `getMesh()` (stride by `numProp` if >3), `STLExporter.parse(mesh, {binary:true})` → DataView → `Buffer.from(dataView.buffer)`; assert bytes = 84 + 50·triCount; then **round-trip**: re-read STL as soup, `mesh.merge()` must return true, `Manifold.ofMesh` status `'NoError'`, volume matches.
- **`validate.js`** — gates of §6. Key free validator discovered by the proof, use verbatim:

```js
// Manifold genus() = 1 − chi/2 summed over ALL boundary surfaces:
// sealed hollow shell = −1;  −genus() = number of PRINT-SEALED cavities.
// Every exported printable part MUST report genus() >= 0 (no cavity sealed at print time).
console.log(`genus: shell=${shell.genus()} (sealed cavity) -> bored=${hull.genus()} (vented, expected 0)`);
```

- **Memory discipline:** every Manifold/Mesh handle is WASM-heap, no GC — `.delete()` all, including intermediates of chained calls (`cylinder().translate()` orphans one) inside any retry loop.

---

## 6. Validation gates (every STL, before delivery)

- **G1 Manifold:** JS float64 signed volume > 0 (winding pre-check) → `status()==='NoError'` && `!isEmpty()` && `volume()>0` at every CSG stage, and again after STL round-trip (`merge()===true`, volume match ±0.1 %).
- **G2 Min wall:** sampled normal-distance audit of the shelled pods ≥ 2.0 mm everywhere (2.25 nominal; naive inset thins tapered regions — fail → thicken stations locally). Bosses/lugs ≥ 3.0.
- **G3 Sealed-cavity/vent check:** `−genus() === 0` for every printed part (no print-sealed voids); additionally, in **print orientation**, every local dome/pocket of every cavity must contain a drain ≥Ø3 or open onto the rim (every-dome-has-a-hole rule — protects the FEP, not just the part).
- **G4 Plate fit:** per-part AABB (in its declared print orientation, incl. skirt + 5–6 mm standoff) ≤ 120 × 72 × 145; pods upright 55 × 70 footprint, ≤130 Z. Blocks export until machine model is confirmed Mono-class.
- **G5 Clearance audit:** walk the joint table (J1–J6); for each mating pair, measured modeled gap = specced class from the machine profile; ERROR on any designed |clearance| < 0.05 mm/side ("below machine scatter — coupon required"); ERROR on any interference fit in resin.
- **G6 Buoyancy recompute:** mesh-integral V_disp at the 0.55 waterline within 40–60 % band; sealed-air volume ≥ 382 cm³ (recomputed per chamber, max single chamber ≤ ~115 cm³); GM_T > +3 mm; **GZ > 0 at every 15° step 0–90°** (mandatory — KG<KB is not achieved).
- **G7 Mass budget:** Σ(part volume × ρ) + ballast nominal + 30 g coating allowance = 323 ± band; per-part masses written to a manifest the owner checks against the 0.1 g scale at step 5 of assembly (catches trapped uncured resin).

---

## 7. Print & test protocol for the owner

1. **Calibrate first:** run RERF/Cones-of-Calibration; freeze exposure, AA, lifts. Never re-tune mid-project.
2. **Coupon plate (P8), ~3 h:** pick pin-socket class, hinge-bore class, thread go/no-go; weigh the 10 mL cube (report grams → density). Report the three picks; engineering re-stamps STLs if they differ from nominal.
3. **Production plates:** P1, P2 (one pod per plate, ~5.5–6.5 h each at 0.05 mm layers), then the small plate (P3, P5, P6, P7, spares — MSLA time is height-only, so spares are free). Check FEP and top up resin before each pod plate. Keep fit features ≥3 mm above the raft.
4. **Post-process** exactly as assembly step 4 (short IPA wash, syringe-flush every cavity/groove/socket, dry fully, warm rotating UV cure with all holes open, optional underwater final pass). Under-washing leaves toxic uncured resin; over-washing (>5 min IPA) crazes surfaces.
5. **Assemble** per §4 order, honoring every cure gate. Do not touch CA glue at any step.
6. **Leak test** (assembly step 9): 24 h submerged, <0.5 g gain per hull on the 0.1 g scale.
7. **Pool trim:** float the finished fish; add dry glass pebbles through the M20 ports until the waterline sits at the 55 % mark (mid-flank; freeboard to top of back = 31.5 mm); rock it — verify it re-rights briskly from pushes and returns from full inversion; then withdraw plugs one at a time, flood each tray with epoxy, re-seat plugs (greased, hand-tight). ~12 g moves the waterline 1 mm.
8. **Observe over the first weeks:** tail wags ±5–15° in light chop, near-zero in glass calm (expected — no energy source), fish weathervanes nose-into-breeze (correct behavior); listen for stop clicks (add RTV pads if annoying); monthly fresh-water hinge rinse; re-grease O-rings at every re-trim; do not leave unpainted test parts in the pool > a few weeks; annual topcoat recoat + inspection.

---

## 8. Numbers appendix

| # | Quantity | Value | Verdict |
|---|----------|-------|---------|
| 1 | Cured resin density | 1.15 g/cm³ (band 1.10–1.20) | confirmed — **(validate: weigh 10 mL coupon cube)** |
| 2 | MSLA density discount vs FDM | 0 % (fully dense) | confirmed |
| 3 | ABS-Like Pro 2 elongation / Izod | 35–40 % / 212 J/m (design to ≤½ TDS elongation) | confirmed |
| 4 | Water absorption (ABS-like, cured) | 0.3–1.0 %/24 h; 1–3 % saturation; wet modulus −10–40 % | confirmed |
| 5 | Linear swell in service | ~0.3–1 % saturation-based (~0.02–0.06 mm on Ø6 pin) | **corrected** (from 0.1–0.3 %) |
| 6 | Hull wall / bosses / fins / blade / peduncle | 2.25 / 3.0 / 1.5 / 2.5 / 1.8 mm | confirmed |
| 7 | Envelope V_env (280×55×70 ellipsoid) | 564.4 cm³ | confirmed |
| 8 | All-up mass at x=0.55 | 323 g (band 198–365 g over 40–60 %) | confirmed |
| 9 | Shell wall volume at t=2.25 (uniform offset) | 94.6 cm³ (not 87.3 scaled-inner) | **corrected** |
| 10 | Structure mass | 176 g nominal (151–203) | **corrected** (from 168) — mesh integral supersedes |
| 11 | Coating mass allowance | 10–25 g computed, budget 30 | **corrected** (from 15–30) — weigh after coating |
| 12 | Ballast | ≈132 g nominal, glass pebble/epoxy 1.8 g/cm³, ~73 cm³, two 60 mm trays | derived from corrected 10–11 — **final by in-pool trim** |
| 13 | Ballast centroid z_b | 15.5–16 mm above keel | **corrected** (11–13 impossible at this density) |
| 14 | KB / BM_T / KM_T at 55 % | 23.8 / 6.9 / 30.7 mm | confirmed |
| 15 | GM_T at 55 % | ≈ +4…+5 mm | **corrected** (from +6.2) |
| 16 | KG < KB self-righting | NOT achieved anywhere in band → GZ sweep mandatory | **corrected** |
| 17 | Righting moment at 10° heel, 55 % | ~2.5 mN·m | **corrected** (from 3.4) |
| 18 | Freeboard / trim sensitivity | 31.5 mm; 0.083–0.086 mm/g (~12 g/mm) | confirmed |
| 19 | Sealed air requirement | 382 cm³ = 68 % envelope = 80 % cavity; chambers ~80/79/112/111 cm³ | confirmed — chamber volumes **(validate: mesh recompute)** |
| 20 | Flood tolerance | 41 g in-band; single-chamber flood floats at 69 %; 239 g to decks-awash | confirmed |
| 21 | Seam bond stress vs allowable | 0.03–0.05 MPa vs 1–2 MPa wet (>20×) | confirmed (peel caveat noted) |
| 22 | Registration pins | 3× Ø3.0 in Ø3.3 × 4.5, 0.15 mm/side | confirmed — **(validate with coupon; Ø3.1 variant rejected as uncertain)** |
| 23 | Hinge clearance | 0.25 mm radial nominal, band 0.15–0.40 (Ø6.0 in Ø6.5) | confirmed |
| 24 | Press fits in resin | BANNED | confirmed |
| 25 | Untestable-fit floor | <0.05 mm/side → ERROR + coupon | confirmed |
| 26 | Hinge droop / free play | ~0.7° tilt, ±1.3 mm tip (vs 3° limit) | confirmed |
| 27 | Hinge friction budget / achieved | ≤0.1 mN·m (reject 0.3) / ~20–50 µN·m | confirmed |
| 28 | Wave driving torque / wag amplitude | ~0.4–4 mN·m at ~32 mm arm; ±5–15° in 5–15 mm chop | estimate — **(validate with first pool test)** |
| 29 | M20×2.5 thread | +0.15 mm radial female offset, 3 turns, r≥0.3 | confirmed — **(validate with coupon row C)** |
| 30 | Ballast-port O-ring | EPDM 21×2 (or 22×2), gland 1.5 × 2.7, ID 21–22, ~25 % squeeze, ≤5 % stretch | **corrected** (from 18×2) |
| 31 | Drain holes | ≥2 per closed cavity, Ø4.0 (floor 3.0/3.5), one per local dome, low+high in print orientation | **corrected** (Ø2.5 variant rejected) |
| 32 | Plug blowout force | 0.19 N on Ø4 at 15 kPa (negligible) | confirmed |
| 33 | Thermal breathing load | ±10–15 kPa; 175 kPa hoop at 2.0 mm wall (~200× margin) | confirmed |
| 34 | G/flex cure / immersion gate | full strength 24 h; immersion 72 h ≥24 °C (7 d <18 °C) | confirmed |
| 35 | Post-cure | IPA ≤5 min, dry 30–60 min, 405 nm 15–30 min at 40–60 °C, optional underwater pass | confirmed |
| 36 | UV-resin cure depth (pigmented) | ~0.3–1 mm per flood pass | **corrected** (from 1–2 mm) |
| 37 | UV degradation uncoated | yellow 2–6 wk, embrittle 2–6 mo → topcoat + annual recoat mandatory | confirmed |
| 38 | Chlorine at 1–3 ppm | negligible attack; EPDM/silicone elastomers only, no nylon pin (swell), CA banned | confirmed |
| 39 | Plate / pod fit | pods 55 × 70 × ≤130 upright in 120 × 72 × 145 usable | confirmed — **(HARD GATE: confirm Mono-class machine; orig. Photon fails)** |
| 40 | Pod print time / resin total | ~5.5–6.5 h per pod at 0.05 mm; 200–250 mL total | estimate ±40 % (machine-dependent) |
| 41 | Toolchain | manifold-3d@3.5.1 + three@0.185.1, STL round-trip byte-exact; genus() = −(sealed cavities) validator | PROVEN in-sandbox |
| 42 | Support scar / skirt | 0.2–0.4 mm scars → zero support contact on any mating face; modeled 2 × 1 skirt ring, 0.3 web | confirmed practice |
