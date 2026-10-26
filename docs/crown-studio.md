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
Real scans: see below.

The result screen shows the verdict and **Export Crown**. **Adjust
Design** (or Help → Pro tools) opens the full stage rail: Scans, Margin,
Axis, Anatomy, Adapt, Check, Export.

**Tooth library:** two complete free library families, Round and
Rectangular, each with every position from central incisor to third molar
in both jaws. They're imported per tooth position, so a #19 crown starts
from the library's own lower first molar (`npm run import-library --
<upper> --jaw upper <lower> --jaw lower --family round`). Round is the
default, and the last review card switches between them. The model files
stay out of git because they keep their publisher's licence.

Library teeth carry their own cervical neck. The design rebuilds every
meridian below its widest point as a smooth convex emergence from the
margin, so blending onto the margin leaves no crease.

**Review deck.** The result is a stack of cards: one per check that warns
or fails, failing ones first.
- Swipe right to accept a warning.
- Swipe left, or tap Adjust, to open the stage that fixes it.
- A failing check can't be accepted.

When nothing is left, the last card shows the key numbers and **Approve &
Export** (**Approve & Send** when embedded). The contacts and occlusal
clearance are also pinned on the 3D crown.

**When the prep isn't obvious (real arches).** Natural teeth are often out
of contact too: front-teeth overjet, crossbites. So the candidates are
ranked by where they sit on the arch compared with the tooth on the order:
1. The ends of the dentition give left and right, and the front of the
   arch gives the anterior direction.
2. The angle from the midline is compared with that tooth's expected
   position.
3. A clear match is picked automatically. Otherwise the best candidates
   show as numbered pins, and one tap picks the prep.

The margin search then tries several occlusal directions (the bite plane,
the direction between the arches, the scan's own estimate) from the stump's
top, and keeps the loop that reads best.

What real scans needed, beyond the synthetic cases:
- **Gum-line margins.** Scans taken without retraction have no visible
  finish line: the gum hugs the prep, and its crest is a convex corner
  about 1 mm outside the prep. When no clear finish line is found, the
  margin is traced at the crease where the axial wall meets the gum. That
  loop is always flagged, and its review card says it was traced at the
  gum line.
- **Path of insertion.** The axis is the least-undercut direction within
  25° of the margin's axis, searched coarse to fine (about 0.7 s), as
  exocad does by default. A technician's tilt is applied on top of it.
- **Neighbours.** The scan is one surface, so the stump's own bulging wall
  and the papilla between the teeth used to count as "neighbour". They are
  excluded now: the stump by flood fill from its top above the margin, the
  papilla by a height floor. A side whose nearest tooth is beyond reach,
  or whose surface never rises to tooth height (gum over an edentulous
  ridge), has no contact. A bridge abutment's pontic side is one example.
- Contact relief stops at the material minimum. A neighbour closer to the
  prep than that is reported, not hidden by thinning the wall.

Measured on the first real case, Laura (3Shape upper arch, opposing lower
in occlusion). The scan has one prepared tooth, a premolar 51° round the
arch. Its neighbours are natural and the edentulous ridge is distal.
- Ordering #12, the prep is found automatically. The gum-line margin traces
  the stump's outline, and the axis tilts 16° to cut the undercut from
  1.17 to 0.69 mm.
- **The prep itself is under-reduced.** The stump comes within 0.43 mm
  of the opposing tooth and 0.47 mm of the mesial neighbour, measured
  directly between the scans. Zirconia needs 0.7 mm occlusal and 0.5 mm
  axial.
- The checks read accordingly: thickness passes, occlusion is −0.34 mm
  (high), the mesial contact is −0.16 mm (tight), and the distal side
  correctly has no contact. In the app: 5 cards to review, 4 of 9 checks
  pass (was 10 of 12 to review), designed in 10 s.
- **The crown shape is not lab-quality on this prep.** The anatomy is
  recognisably the library premolar, but the walls show folds where the
  thickness push meets the contact relief. The vertex-by-vertex constraint
  steps fight each other on a prep this tight. The next step is one
  smooth, joint solve of all constraints (thickness, contacts, occlusion)
  instead of sequential pushes.

`dev/e2e-real.mjs` replays a local case. `dev/crown-scene.html` renders a
crown on the real arches in occlusion. Cases stay in the git-ignored
`dev/cases/`.

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
