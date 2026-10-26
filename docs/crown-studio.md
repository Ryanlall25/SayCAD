# Crown Studio — design notes, validation status, and how to run it

Crown Studio is SayCAD's crown department: a phone-first app that turns a
prep scan and an opposing scan into a finished, checked, millable crown. One
tap on the prep starts the whole pipeline; everything after that is
adjustment by voice, text, AI, sliders or tapping the crown.

This document is for the lab owner and for whoever maintains the code. It
says what the engine does, what has been proven and what has not.

---

## 1. What is proven, and what is not

| Claim | Status | Evidence |
|---|---|---|
| Margin found within scan resolution on a clean chamfer prep | **Proven on synthetic scans only** | 0.05 mm mean error at 0.1 mm mesh spacing, 0.03 mm at 0.05 mm (`margin.test.ts`), same with 15 µm noise in an arbitrary coordinate system (`robustness.test.ts`) |
| Crown is a closed, outward-facing, single solid | **Proven** (by construction and re-checked on every design, including after STL export and reload) | `pipeline.test.ts`, `dev/e2e.mjs` |
| Contacts, occlusal clearance and material minimum thickness hit their targets | **Proven on synthetic cases** | contacts −0.026/−0.025 mm vs −0.03 target, occlusion 0.048 vs 0.05, thickness ≥ material minimums |
| An under-reduced prep is reported, not hidden | **Proven on a synthetic case** | thickness held, crown flagged high, export blocked (`robustness.test.ts`) |
| Anatomy is clinically acceptable | **Not proven.** The built-in anatomy is a parametric textbook template. | — |
| Learned anatomy beats the template | **Not proven.** The training pipeline works end to end, but it has only seen synthetic stand-ins, where it does *not* beat the template (expected: those stand-ins were made from the template). | `ssm.test.ts`, `scripts/train.ts` report |
| Works on real 3Shape / exocad / Medit exports | **Not yet tested** — no real case has been run. | — |
| Finds chamfer and shoulder margins, incl. gingiva 0.15 mm away | **Proven on synthetic scans** | 0.04–0.06 mm mean (`margin.test.ts`) |
| Feather-edge / vertical preps | **Not auto-detected** — the app says so and the margin is drawn by tapping points around the prep | `margin.test.ts` |
| Imports a tooth library in arch layout (STL soup, FDI or Universal names) | **Proven on a synthetic library** — not yet on a real library file | `library.test.ts`, e2e |

**The next step that matters is running `scripts/train.ts` on the lab's real
cases.** Its report answers the open questions with numbers: how far the
margin finder lands from the margins technicians actually used, and how far
auto-designed crowns land from the crowns that shipped.

Material minimums in `src/crown/materials.ts` are typical published values
for single posterior crowns. Each lab must confirm them against the IFU of
the exact puck/block it mills.

---

## 2. The pipeline

```
tap on prep ─► margin (margin.ts) ─► tooth frame (frame.ts) ─► intaglio (intaglio.ts)
                                                     │
                     template (anatomy.ts or learned ssm.ts) ─► outer surface (design.ts)
                                                     │
                                 solid (solid.ts) ─► critics (critics.ts) ─► export
```

**Margin** — radial cross-sections of the scan around an axis through the
stump (`slice.ts`). Each profile is read the way a technician reads it:
occlusal table, axial wall, then the finish line = the first convex corner
below the wall, preferably right after the concave chamfer floor. Several
candidates per profile; a cyclic dynamic program picks the smoothest closed
loop, so one bad profile (scan hole, blood, cord) can't drag the line off.
Each sample gets a confidence (red in the UI). One tap on the scan in "Fix
margin" mode moves the nearest stretch of the line there.

**Frame** — insertion axis from the margin plane and the occlusal surface;
buccal from the curvature of the nearby arch (a parabola through the tooth
tops: the arch centre is lingual); mesial from Universal numbering. A
one-tap "flip buccal" covers short, straight scans.

**Crown grid** (`grid.ts`) — every surface is sampled on meridians × rows from
the margin to the occlusal centre. The parameterization is anatomical, so
the same grid address is the same anatomy on every crown. That gives:
watertight stitching for free (outer and intaglio share the margin row),
correspondence for learning, and named regions ("the distobuccal cusp") the
AI can sculpt by name.

**Intaglio** — the prep surface inside the margin, blocked out along the
insertion axis (no undercuts), offset by the cement gap with a cement-free
band at the margin.

**Outer surface** — template sized to the space (mesiodistal from the
neighbours, height from the antagonist), cervical third morphed onto the
margin, then constraints in rising priority: sculpt edits → proximal
contacts → occlusion (cusp tips raised into contact, high spots relieved,
never below the material floor) → minimum thickness. Thickness always wins;
a conflict shows up as a failing check with the fix spelled out ("not enough
occlusal reduction for this material: ask for more reduction or switch
material").

**Critics** — closed solid, axial and occlusal thickness, outer surface
clears the intaglio, mesial/distal contact, occlusal clearance, undercut
blockout, margin confidence, orientation confidence. Any `fail` blocks export
unless a reason is typed (saved in the design record).

Every design is a pure function of (scans, margin, parameters). Undo is
"previous parameters"; the exported `.design.json` reproduces the crown.

---

## 2b. The interface

The workflow mirrors exocad's wizard (Scans → Margin → Axis → Anatomy →
Adapt → Check → Export) as a tappable stage rail; each stage ends with
**Continue**. The layout follows Apple's HIG for iPhone: a translucent nav
bar with the case title and QC/AI status, the 3D model full-screen behind,
and a bottom sheet with three detents (peek / half / full) that holds the
stage's controls as grouped lists, segmented controls and switches (44 pt
targets, system font, light and dark appearance). The camera keeps the
crown centred in the part of the screen the sheet leaves visible.

One tap on the prep runs the whole pipeline as a visible "Design run":
margin, axis, anatomy, contacts and occlusion, thickness, quality checks,
then (with AI on) an automatic AI fix if anything fails and an AI review.
The "Ask, or say a change" field takes voice or text at any stage.

**New Crown** asks for the minimum, in three swipeable cards:
1. **Tooth:** tap it on the arch chart. Material, shade and an optional
   patient name sit on the same card.
2. **Prep-arch scan.**
3. **Opposing-arch scan.**

Each scan card names the exact file needed ("Upload the LOWER jaw scan —
the arch with the prep on #19"). Swiping forward is held until it has
that file ("Needed now: LOWER JAW SCAN"). A scanner `.zip` or an exocad
`.dentalProject` can fill everything at once; files are placed by name.

Each upload is checked:
- size and units (it catches exports in metres);
- arch, quadrant or single die;
- triangle count;
- a file name that names the other jaw, or looks like a crown;
- whether the arches are in the bite.

**No tap needed.** After Design Crown, the prep is found from the bite
(`src/crown/findPrep.ts`):
- Natural teeth touch the opposing arch; a prepped stump sits 0.6–4 mm
  short of it.
- A clearance map over the arch, eroded by 2 mm, leaves the stump as the
  one large blob.
- If the arches aren't in the bite, or two teeth are out of contact, the
  app says so and asks for a tap.

Proven on synthetic cases: lower, mirrored upper, and an arbitrary
scanner frame, with a margin error under 0.1 mm against the true margin.
Not yet tried on real scans.

The result screen shows the verdict and **Export Crown**. **Adjust
Design** (or Help → Pro tools) opens the full stage rail: Scans, Margin,
Axis, Anatomy, Adapt, Check, Export.

**Tooth library:** the free library imported so far has centrals,
laterals, canines and premolars, upper and lower. Those positions use the
library tooth's real anatomy. **It has no molars.** Molar crowns still use
the textbook template, and the design run says so ("textbook — no library
tooth for this position"). Import molar library teeth (Pro tools → Anatomy
→ library import, or `npm run import-library`) to change that.

The interface has been checked in headless phone emulation
(`dev/e2e.mjs` for Pro tools, `dev/e2e-newcase.mjs` for New Crown) only — **not yet on a physical
phone by a technician.**

---

## 3. AI: what Claude does and doesn't do

Claude never moves vertices. It edits the design through the same commands
a technician types, via tools (`src/ai/crownTools.json`): adjust a parameter,
set the material, sculpt a named region, read the checks, undo. The geometry
engine then enforces contacts, occlusion and thickness exactly as it does for
a human edit. This keeps the AI's mistakes recoverable and every change
auditable.

- **Free-form requests** — anything the deterministic grammar doesn't parse
  goes to Claude with the current state and checks.
- **AI review** — three renders plus the check report; returns a verdict,
  real issues with measured values, and a draft note to the dentist when the
  prep is the problem.
- **Rx photo** — extracts tooth numbers, restoration, material, shade and
  notes. The prompt forbids transcribing patient identifiers, but the
  photo itself still goes to Claude. Use with patient data only if your
  agreement with Anthropic covers it (BAA).

The "AI" that designs the crown is the engine plus the learned shape models.
Claude is the interface and the reviewer, not the geometry.

---

## 4. Running it

### On a phone, today (claude.ai)

The app is published as a private claude.ai page. AI runs on the viewer's own
Claude account (each viewer is asked once); exports download as a `.zip`
with the STL and the design record. The in-app mic is unavailable inside
claude.ai — use the phone keyboard's dictation key in the command box.

Rebuild and republish after code changes:

```bash
npm run build:artifact && node dev/artifact-page.mjs   # then publish dist-artifact/crown-studio.html with the printed files map
```

### Self-hosted (the lab's own server)

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-… SAYCAD_ACCESS_CODE=choose-one npm start   # builds, then serves on :8787
```

Open `http://<server>:8787` on the phone. For the mic, "Add to Home Screen"
and camera capture, serve it over HTTPS (any reverse proxy or tunnel). Set
`SAYCAD_ACCESS_CODE` whenever anyone else can reach the server: without it,
anyone who loads the page can spend the lab's API credit. The model defaults to
`claude-opus-5-5`; override with `SAYCAD_MODEL`.

Development: `npm run dev` (Vite on :5173) and `npm run server` (API on :8787)
in two terminals; Vite proxies `/api`.

### Using a tooth library (e.g. the MOD Institute exocad libraries)

A purchased or free tooth library can replace the textbook template as the
starting anatomy. SayCAD does not ship any library (each carries its
publisher's licence): download the one you're entitled to, then either

- **in the app:** Case → *Import tooth library*, select all of the library's
  tooth STLs at once; the forms are kept on that device only; or
- **on a computer:** `npm run import-library -- ./library-folder --name "MOD library"`
  (writes git-ignored models to `public/models/`).

File names must contain the tooth number, Universal (`19.stl`) or FDI
(`Lower_36.stl`, converted automatically). The teeth must be in their arch
positions as the library ships them (at least 3 per arch): each tooth's
orientation is read from that layout. Learned case models and library models
use the same slot; the most recent import wins for a tooth class.

### Training on the lab's cases

One folder per case, each with the prep-arch scan, the opposing scan and the
crown that shipped, plus a `case.json` (recommended):

```
cases/
  2024-0412-smith/
    upperjaw.stl
    lowerjaw.stl
    crown_19.stl
    case.json        {"toothNumber": 19, "prep": "lowerjaw.stl", "antagonist": "upperjaw.stl", "crown": "crown_19.stl"}
```

Export from 3Shape Dental System / exocad / Medit as STL in the scan's own
coordinate system (the default), so the crown sits on the prep. Then:

```bash
npm run train -- ./cases                 # → public/models/ssm-<class>.json + reports/training-report.md
npm run synthetic-cases -- ./demo-cases  # a dry run on synthetic cases first, if you like
```

The app loads a class's model automatically ("Anatomy: learned from N
cases"). Models are learned from patient-derived designs: keep them in a
private repository.

**How many cases?** The shape model needs at least 3 crowns of a tooth class
to learn anything, and the report's leave-one-out numbers become meaningful
around 15–20 per class. 100 cases spread over molars and premolars is a
reasonable start for posterior crowns; anterior anatomy needs its own set.

---

## 5. Known limits (in priority order)

1. **Not validated on real scans.** See §1.
2. **Single posterior crowns first.** Anterior templates exist but are basic;
   bridges, inlays/onlays, veneers and implant crowns are not built.
3. **Insertion-axis tilt is manual only.** The axis comes from the margin
   plane; the Axis stage tilts it (mesial/distal, buccal/lingual) and
   blockout follows. There is no automatic best-path search yet.
4. **Heavily subgingival or unclear margins** will need the one-tap fix more
   often. The confidence colouring shows where.
5. **Design runs on the phone.** About 1 s per edit on a desktop-class CPU;
   expect 2–4× that on a mid-range phone (preview quality is used while
   dragging sliders).
