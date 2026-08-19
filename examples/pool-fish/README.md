# Pool Fish — Print, Assemble & Swim Guide

A decorative fish that floats at its designed waterline in your pool, wags its
tail in light chop, and re-rights itself when pushed. Every part in `parts/`
passed the full validation suite (watertight geometry, wall thickness, plate
fit, drainability, clearances, buoyancy + righting-arm sweep, mass budget) —
see `parts/gates.integration.json` for the machine-checkable record.

**⚠️ HARD GATE before anything else:** confirm your printer is an Anycubic
**Photon Mono-class or larger (build volume ≥ 130 × 80 × 165 mm)**. An
original Photon / Photon S (115 × 65) **cannot** print the hull pods. The two
hull pods use 126–143 mm of height including supports.

---

## 1. Shopping list

| Item | Spec | Why |
|---|---|---|
| Resin | **ABS-like tough resin**, opaque (Anycubic ABS-Like Pro 2, Siraya Tech Blu, or Elegoo ABS-Like 3.0), ~250 mL | Survives water + the hinge. **Water-washable resin is banned** — it swells and cracks underwater |
| Epoxy | **West System G/flex 650** (655 for gaps) | The only glue used. CA/super glue is **banned** — it lets go underwater in weeks |
| O-rings | **EPDM 21×2 mm ×3** (2 + spare) | Ballast port face seal. EPDM survives pool chlorine |
| UV torch | 405 nm, ~5 W | Flash-curing drain plugs |
| Silicone grease | Pool-grade (Magic Lube II class) | O-rings + threads |
| RTV silicone | Neutral-cure | Retainer cap dab (serviceable) |
| IPA ≥95%, 220-grit + glass plate, exterior UV-resistant clearcoat (spar urethane class) | | Wash, flatten, sun-proof |
| Glass pebbles / coarse aquarium silica | ~150 g | Ballast (poured through the ports — **no metal**) |
| Ø6.0 mm HDPE rod, ~60 mm | optional | Preferred hinge pin (the printed pin `p4-hinge-pin.stl` is the fallback) |

## 2. Print plan (in this order)

1. **Calibrate once:** run RERF / Cones of Calibration for this resin. Freeze
   exposure, anti-aliasing and lift speed — never re-tune mid-project.
2. **Coupon plate first** (`p8-coupon-plate.stl` + `p8-coupon-ring.stl` +
   `p8-coupon-cube.stl` + `p8-coupon-pins.stl`, one small plate, ~3 h):
   - Row A: which socket does a Ø3 pin **thumb-seat and pull back out** of? (3.2 / 3.3 / 3.4)
   - Row B: which bore lets the Ø6 pin **spin freely**? Pick **one looser**. (6.3 / 6.5 / 6.7)
   - Ring: must **run onto the M20 stub by hand**, and the printed **cube must weigh ~11.4 g** (tell me the exact grams — that's the density check).
   - If your picks differ from the middle values (3.3 / 6.5 / thread-OK), say so — I re-stamp the STLs to your machine before you print the big parts.
3. **Production plates:** `p1-front-hull-pod.stl` (one plate, ~6 h), then
   `p2-rear-hull-pod.stl` (one plate). **Print pods exactly as oriented: open
   rim DOWN, on 5–6 mm medium supports under the skirt ring.** Never put
   supports on the rim face, the nubs, or the shiny flat ring under the belly
   (that's the O-ring sealing face). Top up resin before each pod.
4. **Small plate:** `p3-tail-assembly` (blade near-vertical as oriented,
   supports only on the root/leading edge), `p5-ballast-plug` ×3,
   `p6-drain-plug` ×8, `p7-fin-dorsal`, `p7-fin-pectoral` ×2, `j1-seam-pin`
   ×5, `p4a-retainer-cap` ×2 (+ `p4-hinge-pin` ×2 only if you don't have HDPE rod).

## 3. Wash & cure (matters more than usual)

Tilt-drain each pod in the vat 10–15 min. Two IPA baths, **≤5 min total**,
with a syringe flush of: chamber interiors, the seam glue groove, every blind
socket, the O-ring gland ring on the plugs, and the port threads. Air-dry
30–60 min. Post-cure 15–30 min rotating, warm (40–60 °C), **all holes open**.
Snap the skirt rings off after curing. Then weigh **every part** on a 0.1 g
scale and check against `parts/manifest.json` — an overweight part means
uncured resin trapped inside (re-flush it).

## 4. Assembly (each step gates the next)

1. Hand-ream both Ø6.5 hinge bores and the tail bore with a Ø6.0 drill bit.
2. **Dry-fit everything:** pods on their 3 pins (they only fit one way —
   that's intentional), tail on its pin, plugs with O-rings.
3. Plug the three Ø4 drain holes (P6 plugs). **Each pod uses a different
   route — this matters, one of them is physically impossible the other
   way:**

   - **Rear pod:** its bulkhead drain goes in **through the rim**, from
     inside the open pod. It sits ~60 mm in — use tweezers and shine the UV
     torch through the opening.
   - **Front pod — BOTH its plugs go through the front belly port**, the Ø20
     threaded hole at the nose end of the belly, before the ballast plug
     goes in. One sits ~29 mm forward of the port (the nose bulkhead), the
     other ~21 mm aft of it (the seam diaphragm, the wall just behind the
     front pod's flange). Neither is reachable from the rim: the diaphragm
     is a solid wall across the whole pod and the only gap in it is the Ø4
     hole you are plugging.

   Wet each plug with resin, 60–90 s UV flash in 2–3 passes. Seal the two Ø3
   shell vents (nose belly + near the tail) the same way.

   *Why it matters:* the diaphragm is what keeps the front and middle
   chambers separate. Leave either front plug out and two chambers become
   one — and the nose one sits *below* the pebble fill line, so ballast and
   epoxy would run forward into the nose.
4. **Glue the one seam:** sand both rim faces flat on 220-grit over glass,
   scuff, IPA wipe. G/flex bead in the groove, mate on the 3 pins until the
   little nubs touch, tape-clamp **24 h**.
5. Epoxy the three fins into their sockets (tangs are Ø6.0 — dorsal on top of
   the front pod, two pectorals low on the rear pod sides). Epoxy fillet band
   8–10 mm wide over the seam and all plugs. **Do this before the leak test:**
   the three fin sockets open straight into the sealed chambers, so a hull
   with bare sockets is not sealed yet — it would "fail" a leak test that has
   nothing wrong with it.
6. **Leak test:** once the fin epoxy has cured, submerge the glued hull 24 h
   at ~30 cm. PASS = it gains less than 0.5 g. Do not continue until it
   passes.
7. Mask the hinge bores, pin, port threads and the flat O-ring faces →
   2 coats exterior UV clearcoat. (Unpainted resin yellows in weeks and gets
   brittle in months of sun.)
8. Fit the tail: drop the pin through (head up), silicone-dab a retainer cap
   onto the bottom tip. The tail must swing ±30° to its stops and turn under
   a feather touch.
9. **Cure gates before water:** 72 h after the last epoxy (a week if the
   room is cold), 48 h after RTV, clearcoat per its label.

## 5. Pool trim (the fun part)

Float the fish. Pour dry glass pebbles through the two belly ports (unscrew
the knobs — they protrude under the belly by design, that's your grip) until
the waterline sits mid-flank — there are **witness tabs inside each tray:
fill pebbles level with the tabs** and you'll be within a few grams (~120 g
total). ~12 g moves the waterline 1 mm. The front and rear trays are separate
walls-apart chambers, so shifting a few grams between them levels any
nose-up/nose-down tilt. Push it over — it
must pop back upright, including from fully flipped. When happy: pull one
plug at a time, flood that tray with epoxy, re-seat the plug greased,
hand-tight to the shoulder. **Never wrench them, never PTFE tape** — the
O-ring face does the sealing.

Expected behavior: tail wags ±5–15° in light chop, near-still in glass calm
(no motor — the waves are the motor), nose weathervanes into the breeze.
Monthly: fresh-water rinse of the hinge. Yearly: re-coat.

## 6. What to tell me after the coupon plate

1. Row A pick, Row B pick, thread go/no-go
2. The density cube's weight in grams
3. Your printer model

If anything differs from nominal I regenerate the affected STLs in minutes —
the whole fish is parametric code (`src/`), not hand-modeled.
