# The Corrective Engine

Architecture for SayCAD's plan–build–critique–repair system. Audience: the developers (human and AI) who will implement it, and the lab owner who must be able to follow what the machine is doing and why. Every number carries units; corrected figures from verification supersede the originals; figures we could not verify are marked **(to validate empirically)**.

---

## 1. Vision

SayCAD today is a deterministic speech grammar (18 command kinds in `src/speak/parser.ts`) driving a three.js scene, with versioned design docs (`design_vN.saycad.json`, `src/shared/saycad.ts`) and a bounded undo stack. The corrective engine extends that discipline from *executing commands correctly* to *building things correctly*: it plans a part graph, builds it one step at a time, critiques every step with computable validators, and repairs failures with bounded numeric edits.

The distinguishing move is what happens when repair is provably hopeless. The engine does not thrash and it does not restart. It **checkpoints** the exact state — plan, cursor, every open objection — opens a **research branch** that asks targeted questions about the actual blocker, compiles the answers into a revision of the *plan*, and **resumes from the checkpoint**, rebuilding only what the revision touched. Never from zero.

Three invariants carry over from the existing codebase and govern everything below:

1. **Nothing mutates the scene except through the grammar/IR.** The LLM plans; a deterministic executor builds.
2. **Geometry is a pure function of the plan.** Same IR + same executor version = bit-identical mesh. This is what makes checkpoints kilobytes instead of megabytes.
3. **Transforms live unbaked on `mesh.matrix` until export.** Critics bake into scratch copies at their own boundary; the scene stays lossless.

A corollary that is the load-bearing rule of the whole engine: **research findings merge into the plan, never into the mesh** (§2.4).

---

## 2. The loop

### 2.1 State machine

The engine is a pure reducer `engineStep(state, event) -> state` in `src/engine/engine.ts`, written in the same style as `parser.ts`: discriminated unions, no framework, every transition vitest-testable with synthetic verdict streams. Geometry execution and critic runs happen in the caller between transitions, exactly as `parse()` is separated from `runCommand()`.

States: **PLAN, BUILD, CRITIQUE, REPAIR, STUCK** (transient, checkpoint-writing), **RESEARCH, RESUME** (transient, cursor-restoring); terminals **DONE, NEEDS_USER, ABORTED**.

Transitions:

| From | Event | To | Guard |
|---|---|---|---|
| PLAN | planReady(partGraph, steps[]) | BUILD (cursor = 0) | replay the **entire objection ledger** against the new plan; a revision that reintroduces a previously-objected configuration is rejected before any geometry is built |
| BUILD | stepExecuted | CRITIQUE | executes exactly one plan step through the deterministic executor |
| CRITIQUE | allPass | BUILD next step / DONE | DONE only past the last step with assembly-level critics green; writes a green checkpoint |
| CRITIQUE | fail | REPAIR | one objection opened per failed verdict — unless a stuck heuristic fires → STUCK |
| REPAIR | paramDelta | BUILD (same step, attempt+1) | delta must come from a critic hint or bounded line search, stay inside each param's declared [min, max], and change **no topology** (no parts/joints added, removed, or retyped) |
| STUCK | checkpointWritten | RESEARCH | — |
| RESEARCH | answersCompiled(PlanDelta) | PLAN → RESUME | delta validated like `parseDesignDoc`: rejected with a message, never applied partially |
| RESEARCH | unanswerable, or 2nd recurrence of same objection signature | NEEDS_USER | — |
| RESUME | invalidationComputed | BUILD at earliest invalidated step | see §6.3 |
| any | budget exhausted | ABORTED | report of open objections |

Core invariant, enforced in guard code, never by the LLM: **BUILD of step i+1 requires `openBlockingObjections(steps ≤ i) === ∅`.**

### 2.2 The objection ledger

Every critic verdict serializes to a machine-readable record:

```ts
Objection {
  id, critic, stepId, partIds[], jointId?,
  severity: 'block' | 'warn',
  measured: { name, value, unit },
  required: { op: '>=' | '<=' | 'in', value | range, unit },
  hint?:    { param, direction: +1 | -1, stepSize },
  status:   'open' | 'satisfied' | 'waived',
  waive?:   { reason, author: 'user' | 'planner', atIter },
  openedAt: { iter, revision }, resolvedAt?, inputsHash
}
```

Status transitions are restricted: only a re-run of the **same critic** can set `satisfied`; only an explicit waive record with a non-empty reason can set `waived`. The planner may *propose* a waive; deterministic guard code records it, and it persists into the export manifest (e.g. "float-margin waived: user accepted 8% freeboard"). STL export is soft-blocked while blocking objections are open — override is a blanket waive, logged. `inputsHash` (hash of the owning step's params + recipe + joint params at satisfy time) is what makes cached verdicts valid on resume.

Numeric `measured`/`required` fields are not decoration: they enable improvement tracking (S1), interval-infeasibility proof (S3), and hint-driven repair. "The model said it looks fine" is not a state this system can be in.

### 2.3 Stuck detection

Evaluated after every CRITIQUE, first hit wins:

| # | Heuristic | Trigger |
|---|---|---|
| S1 | Consecutive failure | same (stepId, criticId) fails 2 consecutive critiques after ≥1 repair AND the last repair improved \|measured − required\| by <25%. A ≥25% improvement grants extra attempts, hard cap **4 attempts/step** |
| S2 | Oscillation | opposite-sign repairs on the same param within the last 4 repairs; or revisit of a previously seen param vector (rounded to each param's step, default 0.05 mm, then hashed — cycle detection robust to float noise) |
| S3 | Interval infeasibility | two open objections bound the same scalar from both sides with lowerBound > upperBound → STUCK immediately, remaining repair budget skipped |
| S4 | No progress | progress score P = passedSteps + fraction of current step's metrics satisfied, appended to `progressTrace`; flat max(P) over 3 iterations |
| S5 | Escalation | same objection signature (criticId + partId + requirement rounded to its step) reaches STUCK twice across plan revisions → NEEDS_USER instead of a third RESEARCH |

Budgets: 4 build attempts/step, ≤5 research questions per STUCK event, ≤2 research rounds per objection signature, 200 engine iterations/project then ABORTED, critique history ring-buffered at 200 records (mirroring `UndoStack`'s 100-entry discipline).

S3 proves emptiness only for single scalars; coupled multi-parameter infeasibility is caught by the S1/S4 backstops.

### 2.4 Research revises the plan, never the mesh

This is a hard rule, for five reasons:

1. **Provenance/replay.** Geometry is a pure function of recipe + seed. A mesh-level patch is state no plan step explains, and the next re-derivation (any resume, reload, or revision) regenerates the part and silently erases the patch — the same reason SayCAD never bakes transforms until export.
2. **Propagation.** A finding like "use a clevis hinge with a Ø6 mm pin" changes the mating boss on the body, print orientation, and the clearance constraint itself. Only the planner sees the joint edges to propagate this; a tail-mesh patch leaves the body stale.
3. **Ledger semantics.** Objections reference plan entities (step/part/joint), not triangles. Only a plan whose re-critique passes can discharge one; a mesh patch discharges nothing.
4. **Minimal resume.** A PlanDelta supports diffing — invalidated = changed parts/joints plus joint-edge dependents. A mesh patch carries no dependency information: full rebuild, or unsound trust in stale verdicts.
5. **Transfer.** Plan-level constraints ("printed-apart pool hinges want 0.25–0.5 mm radial clearance") are reusable rules for future projects; mesh edits are not.

RESEARCH mechanics: on STUCK, freeze the cursor, write the checkpoint, generate ≤5 questions from the open objections via three templates — (a) *requirement audit* ("is ≥0.30 mm radial the right clearance for this process/material?"), (b) *mechanism alternatives* ("what joint types achieve this role under the surviving constraints?"), (c) *domain norms* ("published parameter ranges for this mechanism at this process spec"). Each question carries `objectionIds` so answers stay traceable. Answers — from the LLM, the web, the user, or a **physical experiment** (a 15-minute printed tolerance coupon is a legitimate research action; see fit table, §9.B) — compile into a typed `PlanDelta {removeParts, addParts, editParams, editJoints (type changes allowed here and only here), addConstraints, proposeWaives}`. Applying a delta increments `partGraph.revision`.

The NEEDS_USER terminal is mandatory infrastructure, not a nicety: in a browser session with no LLM/API reachable, the machine must hand off rather than deadlock.

---

## 3. Part-graph IR

### 3.1 Why LLM → IR → deterministic executor

Prior art splits into Turing-complete code-CAD (OpenSCAD, CadQuery, JSCAD — expressive but undiffable and statically unanalyzable) and flat learned command sequences (DeepCAD/Text2CAD sketch-extrude vocabularies — validatable but abstraction-poor). The right middle is a **declarative DAG with bounded arithmetic expressions**. Four concrete grounds:

1. **Deterministic replay.** Same IR + executor version = identical mesh, so a checkpoint is a ~10–30 KB JSON document plus a step cursor (estimate for an 8–15 part model), not multi-MB mesh snapshots, and resume is a memoized partial rebuild keyed by content-hash of each node's subtree.
2. **Diffable plans.** Repairs are RFC 6902 JSON patches against named node ids (`fast-json-patch`); the critic points at `parts/body_front/features/2` and the LLM edits one number.
3. **Front-loaded validation.** Schema (`ajv`), unit ranges, dangling frame refs, joint-clearance and wall-thickness table checks all run in milliseconds *before* tessellation, leaving only manifoldness/min-wall/overhang/buoyancy for post-build.
4. **Bounded action space.** The model emits to a schema via constrained tool-use and receives typed executor errors `{nodeId, code, message, measured, limit}` it can repair. The compile-rate literature says this is exactly what free-form CAD code lacks: GPT-4 reaches only 96.5% compile on free-form CAD code, Gemini 85%, CodeLlama 73.5% (CADPrompt, arxiv.org/html/2410.05340v2). A schema-validated IR converts those crashes into repairable diagnostics.

### 3.2 Document shape

```jsonc
{
  "irVersion": 1, "units": "mm", "goal": "…",
  "params": { "bodyL": { "value": 300, "min": 150, "max": 400, "doc": "…" } },
  "parts": [ /* §3.3 */ ],
  "joints": [ /* §3.4 */ ],
  "assembly": { /* §3.6 */ }
}
```

Values are literals or bounded arithmetic expression strings over params (`"=bodyL/2-1.5"`), evaluated by a tiny deterministic evaluator — no loops, conditionals, or recursion. Repetition is expressed by pattern features and joint `count` fields.

### 3.3 Parts

`Part { id, label, base, features[], frames{}, print{} }`

- **base**: one of `primitive` (box|cylinder|sphere|cone, dims_mm, cornerR_mm?), `extrude` (profile, h_mm, taperDeg?), `revolve` (profile, angleDeg), `sweep` (profile, path segments), `loft` (profiles[], ruled?). A profile is a closed 2D loop of line|arc|bezier segments (or shorthand `rect w h r` / `ellipse a b` / `ngon n r`) on a named plane `{o, z, x}`.
- **features** (ordered): `boolean` (union|subtract|intersect with a base or part ref), `holeAt` (frame, d_mm, depth_mm|'through', counterbore), `shell` (mm, open:[frameRefs]), `fillet2d`/`chamfer2d` (profile corners, r_mm), `pattern` (linear|radial, count, pitch_mm|stepDeg).
- **frames**: named datum frames `{o, z, x}` per part. **Positional/topological selectors are forbidden** — holes, shell open-faces, joints, and assembly checks reference `part:frame` pairs only. CadQuery's `faces(">Z")` strings and FreeCAD's topological naming break when an upstream edit renumbers faces — fatal for a loop that edits upstream nodes constantly. Frames also give the LLM a coordinate vocabulary it handles better than face indices.
- **print**: `{ up, material: 'PLA'|'PETG'|'resin', class: 'free'|'snug'|'press', minWall_mm, supports: 'none'|'allowed', sealed: bool }`. Validators derive directly from it: wall floors, overhang vs. up-vector, and — for `sealed` parts — the buoyancy accounting of §7.

Shells are computed *parametrically* (Clipper2 `CrossSection.offset` of the profile, inset primitive dims), not as general mesh offset, which Manifold lacks. Fillets are restricted to where they are exact and cheap: arc insertion in 2D profiles pre-extrude, and primitive corner radii. General 3D edge fillets are deferred (would force opencascade.js, ~9 MB+ gzipped WASM vs ~1 MB-order for manifold-3d — both to verify at integration).

### 3.4 Joints as generative macro-features

`Joint { id, type: 'pin'|'snap'|'key'|'clevis-pin-hinge'|'glue', a: {part, frame}, b: {part, frame}, d_mm, len_mm, count, pitch_mm, class: 'free'|'snug'|'press', key: 'none'|'D'|'lobes-n' }`

The executor expands one joint spec into **both** mating solids — boss with 45° 0.8 mm lead-in chamfer and +0.5 mm depth slack on part A, pocket on part B — applying radial clearance from a per-process table **on the female side only**:

| Class | FDM (0.4 mm nozzle), per side | SLA, per side |
|---|---|---|
| press | 0.05 mm | 0.025 mm |
| snug | 0.15 mm | 0.05 mm |
| free | 0.30 mm | 0.10 mm |

Fit is therefore correct by construction: the critic never cross-checks independently emitted male/female geometry, and "parts do not assemble" becomes a table lookup plus arithmetic *before* any geometry exists. Snap joints synthesize a cantilever arm and the executor rejects specs where strain `ε = 1.5·t·y/L²` exceeds the material limit (PLA ~2%, PETG ~4% ultimate; design allowables in §9.B). Keyed joints add a D-flat (depth 25% of d) or n-lobe polygon. Joint intent (`kind`, `loadVector`, `cycles`) is a first-class field — a missing load annotation is itself an ERROR, because strength-axis critics silently pass without it.

These table values are memory-sourced defaults: a lab printer that differs makes joints fail physically while passing validators. The one-time printed calibration coupon (§9.B) rewrites the table.

### 3.5 The grammar bridge

Each part carries a `recipe`: a list of sentences in the existing speak grammar, and the planned grammar gains joint/split productions (`pin 4 8`, `socket 4.4 8.5`, `dovetail 10 4 20`, `split it along x at 120`) with executor defaults stamped from the fit table. The LLM front-end contract is unchanged: it compiles to grammar/IR, never to raw scene mutations. Critic repair suggestions are themselves grammar sentences (§5.2), so the repair channel reuses the same firewall.

### 3.6 Assembly: a joint tree, not a constraint solver

`assembly: { root: partId, attach: [jointIds], checks: [{t: 'coaxial'|'coplanar'|'distance'|'noCollide', a: 'part:frame', b: 'part:frame', value_mm?, tol_mm: 0.01}] }`

Child pose = parent frame composed with the joint's canonical alignment (b.frame z anti-aligned to a.frame z, x aligned); each part attaches exactly once. Closed-loop or extra relations are **demoted to computable residual checks** (noCollide via Manifold intersect volume < tol) that FAIL with a named diagnostic — never solved iteratively. A numeric solver would reintroduce nondeterminism and unexplainable failures; a tree is deterministic, replayable, and every violated check maps to a node id the repair loop can act on. (Articulated mechanisms would need a real solver; out of scope for v1.)

---

## 4. Geometry kernel decision

### 4.1 The stack

| Package | Version | License | Role |
|---|---|---|---|
| `manifold-3d` | 3.5.1 (pin), Jun 2026 | Apache-2.0 | **Sole kernel of record.** Every boolean that reaches STL export round-trips through Manifold. Guaranteed-manifold booleans (symbolic perturbation, closed under union/difference/intersect), plus `volume()`, `surfaceArea()`, `genus()`, `decompose()`, `levelSet()` as free validators and a rescue path. Adopted as OpenSCAD's new backend and by Godot 4.x CSG. |
| `three-mesh-bvh` | 0.9.14, Aug 2026 | MIT | Analysis/spatial-query layer for all printability critics (thickness rays, clearance, overhang, shapecast sections). Operates directly on the render `BufferGeometry`; kept **out of the geometry-mutation path**. |
| `three-bvh-csg` | 0.0.18 | MIT | **Optional, preview only.** Fast live-drag booleans on render geometry; output always discarded and the op re-run through manifold-3d on commit. Its output is not guaranteed watertight — a 2026 browser benchmark measured watertight results on **22 of 1000 boolean pairs** (polydera.com). One leaked crack in a float chamber sinks the fish. Safe to skip entirely in v0.2. |

Rejected: `opencascade.js` (LGPL-2.1 friction, beta, tens-of-MB WASM, B-rep power irrelevant to a triangle pipeline — revisit only when true edge fillets/NURBS are demanded); `@jscad/modeling` and BSP ports (`three-csg-ts` etc.) — polygon-splitting booleans produce slivers and T-junctions, no manifold guarantee, degrade toward O(n²), unsafe at 100k triangles.

Enforcement is an **assertion at the exporter**, not a convention: geometry that did not come out of Manifold does not export.

### 4.2 Integration seam (worker-hosted, ~60 lines, BufferGeometry in/out)

1. On commit, per operand: clone the position array and apply `mesh.matrixWorld`. Geometry stays unbaked in the scene per `sceneModel.ts`'s lossless-transform rule; baking happens only at the kernel boundary.
2. If non-indexed (STL soup): `BufferGeometryUtils.mergeVertices(geo, 1e-3 mm)` to weld. Pass the tolerance **explicitly** — the three.js default is 1e-4 units, not 1e-3. 1e-3 mm sits ~30–100× above float32 quantization noise at 100–256 mm coordinates and ~100× below the smallest printable feature, which is where a weld epsilon belongs.
3. `const m = new Mesh({numProp: 3, vertProperties, triVerts}); m.merge(); new Manifold(m)` — a thrown status (e.g. `NotManifold`) is a validator failure, not a crash.
4. Apply the op: `a.subtract(b)` / `add` / `intersect` (also available: `hull`, `extrude`, `revolve`, `splitByPlane`, `trimByPlane`, `decompose`, `levelSet`).
5. `result.getMesh()`; transfer `vertProperties`/`triVerts` back as transferables; build a new `BufferGeometry`, `computeVertexNormals` (or Manifold `calculateNormals` with a sharp-angle threshold for crisp CAD edges); wrap as a new DesignObject with identity matrix.
6. `delete()` every Manifold/Mesh handle — the WASM heap is not garbage-collected; a leak in the retry loop exhausts it mid-session (default ceiling ~2 GB). Wrap solids in a scoped arena tied to the memoization cache.
7. Persist the CSG op tree (op + child refs/primitive params) in the versioned design doc and cache Manifold handles by content hash, so the engine re-runs from a checkpointed node, never from scratch.

The WASM build is single-threaded (no TBB): run it in a Web Worker. A two-×-100k-triangle boolean costs ~50–300 ms plus ~10–50 ms conversion each way **(engineering estimates — benchmark in-repo before the critique loop budgets against them)**. Enabling threads later requires COOP/COEP headers (SharedArrayBuffer), a hosting change.

Two systemic traps every critic and the seam must respect: **(a)** transforms are unbaked until export — skip the bake and every mm threshold is wrong under scale; **(b)** the scene is Y-up (grid at Y=0) while printers are Z-up — printability critics apply a fixed axis map.

### 4.3 Import-repair ladder

Scanned/downloaded STLs that fail `new Manifold()`: (1) mergeVertices at 1e-3 mm, retry; (2) escalate weld to 1e-2 mm once, retry; (3) voxel rescue — sample an SDF of the broken mesh via three-mesh-bvh (inside/outside by ray parity) on a 1–2 mm grid and remesh with `Manifold.levelSet`, which outputs a guaranteed-manifold approximation; (4) if the SDF rescue distorts beyond tolerance (Hausdorff check via `closestPointToGeometry`), stop and open RESEARCH with the concrete failure (status string, open-edge count). Manifold deliberately does not hole-fill; without this ladder every import failure looks like an engine bug. The same levelSet route — not scaled-copy subtraction, which is wrong for non-convex bodies — is the hollowing fallback for free-form shells, at the cost of ~1–2 mm grid smoothing.

---

## 5. Critics catalog v1

### 5.1 Suite architecture

Eleven critics run as a strictly cost-ordered, gated pipeline of four stages. A BLOCKING failure at stage k suppresses stages >k **for that part only** — sibling parts keep validating. Every verdict is cached keyed on `(criticId, xxhash of position buffer, worldScale, paramsHash)`.

- **S0 graph/parametric** (<1 ms total): C0, C4-phase-A.
- **S1 linear mesh scans** (2–80 ms per 100k-tri part): C1, C2, C3, C5.
- **S2 BVH queries** (one amortized MeshBVH build, 100–250 ms/100k tris, then C6, C7).
- **S3 heavy/assembly**: C8, C9, C10, C4-phase-B.

S0–S1 on the main thread; S2–S3 in a Web Worker on transferred Float32Arrays (`MeshBVH.serialize()/deserialize()` ships trees across). Preamble for every critic: bake `matrixWorld` into a scratch world-space copy; map scene +Y → printer +Z.

**Budget (corrected):** cold full suite on a ~10-part, 100k-tri-per-part assembly: **2–5 s** on a desktop core — and that holds *only if* the C4b voxel backstop runs selectively on ≤1–2 flagged parts (run on all 10 it alone costs ~10–25 s). Incremental re-check after one repair: **0.2–0.7 s** (BVH rebuild + manifold + wall rays + the assembly-level buoyancy cache miss); 0.1–0.3 s is reachable only for small parts or with a warm-started waterline. All figures are desktop-class single-core JS; phones run 2–5× slower. A vitest benchmark on deterministic procedural fixtures ships with the integration PR and turns these planning numbers into CI-tracked ones.

### 5.2 Objection shape and the RESEARCH trigger

```jsonc
{ "criticId": "C6.wall-thickness", "partId": "fish.body.port-hull", "jointId": null,
  "severity": "blocking",
  "measured": { "value": 0.62, "unit": "mm", "at": [12.3, 4.1, 20.0] },
  "required": { "op": ">=", "value": 1.6, "unit": "mm" },
  "suggestion": { "text": "thicken hull wall", "commands": ["scale it 130%"] } }
```

`suggestion.commands` MUST be sentences the deterministic grammar parses; the planner replays them verbatim. Empty `commands[]` with non-empty `text` marks a fix the grammar cannot express — 2 consecutive such objections on the same (criticId, partId) is a computable RESEARCH trigger, not a vibe.

### 5.3 The catalog

Costs are per 100k-triangle part on a desktop core unless noted; **est.** = estimate pending the benchmark harness, **meas.** = empirically verified.

| ID | Critic | Guarantees | Algorithm sketch | Blocking | Cost |
|---|---|---|---|---|---|
| C0 | Graph sanity | plan is executable: ids, kinds, mm dims in 0.4–400 mm, material in density table, joints reference real parts with fit class + insertion axis + depth, assembly order is a DAG, ≤24 parts | JSON-schema validate (return objections, never throw, mirroring `parseDesignDoc`); referential integrity; range/enum checks | **B** | <0.1 ms |
| C1 | Bed fit / build volume | part fits the printer in some orientation; units sane | bake AABB; unit sanity (<1 mm or >400 mm extent fails with a scale suggestion — catches m-vs-mm); sorted-extent test vs bed minus 2×5 mm margin; 24×15° yaw search on the convex hull; else suggest split/scale | **B** | 2–3 ms (+15 ms hull) est. |
| C2 | Manifold / watertight | closed, consistently outward-oriented 2-manifold — precondition for every integral, offset, CSG downstream | weld (1e-3 mm, explicit); drop degenerates; directed-edge counting — each undirected edge exactly twice, opposite directions (once = hole, >2 = fin, same-direction = flipped winding); union-find shells, per-shell signed volume >0; manifold-3d constructor as the authoritative cross-check | **B** | 30–80 ms with **sorted typed-array edge counting** (meas.; a naive Map implementation runs ~2× slower — corrected, spec the typed-array path); manifold-3d path 50–150 ms |
| C3 | Mass properties | signed volume >0, finite mass and CoM — feed for C8/C10 | one divergence-theorem pass: dV = dot(v0, cross(v1,v2))/6, centroid Σ(v0+v1+v2)/4·dV, float64, centroid-shifted; ρ_eff models FDM interior (shell t=1.2 mm, infill 15% default); cross-check Σ V vs `manifold.volume()` at 1e-6 rel tol as a self-test | **B** | ~5 ms meas. |
| C4 | Min feature size vs nozzle | no positive feature below the 0.4 mm nozzle vanishes or prints as mush | **Phase A** (S0, parametric — geometry is grammar-built, so 95% of violations are provable from declared dims for free): ribs ≥0.8 mm, load-bearing pins ≥3 mm Ø (floor 1.5 mm), holes +0.3 mm comp, text stroke ≥0.6 mm. **Phase B** (S3, imported/sculpted meshes only): voxelize by all-hits BVH column rays, parity fill, two-pass chamfer distance transform, erode by 0.4 mm; components that vanish are unprintable | **B** <1 line width, advisory 1–2 | A: <0.1 ms. B: **1–2.5 s** in JS (corrected; sub-second needs Uint16 3-4-5 chamfer or WASM). Pitch = max(0.2 mm, extent/256); 0.2 mm pitch resolves walls only for parts ≤ ~51 mm |
| C5 | Overhang / support need | area-weighted support estimate + better-orientation suggestion pre-slice | per-triangle cosDown in printer frame; support-needing beyond 45° from vertical (the standard design-for-print rule — *not* a universal slicer default: Cura 50°, PrusaSlicer ~35°, Bambu ~60° equivalent); 5°-bin area histogram; bridges ≤8 mm exempt; if support area >30%, argmin over 18 canonical orientations | advisory | ~5 ms (+90 ms search) est. |
| C6 | Min wall thickness | no wall below t_min (default 0.8 mm = 2×0.4 mm lines; pool preset 1.6 mm) | 4,000 area-weighted surface samples; from p − 0.01 mm·n̂ cast along −n̂; nearest **back-face** hit = local thickness (a front-face first hit = inverted/self-intersecting → cross-report to C2); 4 extra rays in a 20° cone catch oblique walls; densify around the 20 thinnest; report min, p1, histogram | **B** | 20k rays = **100–250 ms** (meas., ~5–12 µs/ray; the 1–3 µs premise was 2–4× optimistic — corrected). Screening mode: 4–6k rays for 20–60 ms |
| C7 | Interference + joint clearance | no overlap at nominal pose; every joint gap inside its fit band (per side: press 0.05–0.15 mm, slide 0.15–0.30 mm, loose 0.30–0.50 mm; FDM XY accuracy ~±0.2 mm) | broad-phase inflated AABBs; `intersectsGeometry` — any tri-tri hit is a blocking overlap; 500–1,000 area-weighted samples on A's mating faces → `closestPointToPoint` vs B's BVH; require band_min ≤ dMin and dMax ≤ band_max (the dMax bound catches sloppy joints) | **B** | 50–150 ms/joint est. |
| C8 | Bed packing / plate count | plate count + layout feasibility | footprint = XY AABB at print orientation + 5 mm brim + 2 mm spacing; first-fit-decreasing shelves on the usable bed; report plates, utilization %, filament mass from C3 | advisory (B if goal fixes plates) | <1 ms (late by data dependency, not cost) |
| C9 | Assembly path | every part reaches its socket along its declared straight insertion axis without hitting already-placed parts | retract along −â in 16 steps out to L+10 mm; swept-AABB broad phase then `intersectsGeometry`; convex-hull proxy (≤2k tris) for a conservative ~10× cheaper sweep. **v1 is straight-line only** — rotation/flex insertions route to RESEARCH by construction | **B** | 0.2–0.5 s/joint full-res, ~50 ms hull proxy est. |
| C10 | Buoyancy / static stability | assembly floats at a computable waterline with positive small-angle righting | m_total from C3; float iff m_total < ρ_w·V_envelope (sealed hulls' C2 pass is a hard precondition — enclosed air *is* the flotation); draft by 15-iteration bisection on plane clips (resolves <0.01 mm; monotonic, provably converges); B = clipped centroid; waterplane I_xx, I_yy by Green's theorem; **GM = KB + BM − KG**, BM = I_min/V_sub; require GM > 0, advise GM ≥ 5% of beam and freeboard ≥ 10 mm; KG must include payload; contained liquid takes a free-surface correction | **B** when goal says float | 0.15–0.45 s meas. |

Density table (C3/C10): PLA 1.24, PETG 1.27, ABS 1.04, ASA 1.07, TPU 1.21 g/cm³ (filament TDS values — as-printed parts run 2–8% less dense, conservative for buoyancy reserve but note it when mass sets ballast/KG); water at 25 °C pool temperature 0.997 g/cm³ (full 15–35 °C range 0.994–0.999 g/cm³ — corrected; 1.000 is never reached above 4 °C).

Per-joint critics scale linearly with joint count: ~30 joints pushes the cold suite toward 10 s — cap joints in C0 or parallelize joints across workers. Ray-sampled wall thickness is probabilistic: the reported min is an **upper bound** on the true min; certify watertight parts with raised sample counts or the C4b voxel pass.

---

## 6. Checkpoint & resume format

### 6.1 Design doc v2

Bump `SAYCAD_DOC_VERSION` 1 → 2. `parseDesignDoc` must dual-accept v1 and v2 (v1 loads with `corrective: undefined`), keeping the return-null-never-throw contract — and the dual-accepting parser must ship **before** the first v2 writer, since current clients reject any version ≠ 1 (refuse, not corrupt: acceptable). One optional top-level block:

```jsonc
"corrective": {
  "engineVersion": 1, "goal": "…",
  "partGraph": { "revision": 4, "parts": [...], "joints": [...] },
  "planSteps": [...],
  "cursor": { "stepIndex": 7, "attempt": 2 },
  "builtParts": ["..."],
  "objections": [ /* full ledger: open + satisfied + waived */ ],
  "critiqueHistory": [ /* ring buffer, cap 200 */ ],
  "research": { "open": [{ "id", "text", "objectionIds", "askedAtIter" }],
                "answered": [{ "questionId", "answer", "source", "confidence" }] },
  "progressTrace": [ ... ], "rngSeed": 12345, "libVersion": "three@0.180.x"
}
```

No procedural mesh bytes are stored: parts re-derive from recipe + rngSeed at ms-scale per step; imported meshes keep `sourceFileId` exactly as today; the existing `objects[]` array remains the render-state snapshot of finalized parts. Checkpoints are a few KB and are written (a) after every step that passes critique, (b) on STUCK entry, (c) on every plan revision — via the existing `nextDesignVersion()`/`designFileName()` machinery, so the engine's history *is* the case's design-version history. Compact satisfied objections older than the previous revision into summary records to bound growth.

Determinism guard: a three.js version bump can change procedural geometry. Record `libVersion` + `rngSeed`; refuse silent cross-version resume and offer re-critique-all instead.

### 6.2 Memoization

Canonical-JSON content-hash of each node's subtree, plus executor semver, keys the built-solid cache. Any change to joint expansion or profile tessellation is a semver bump, or old designs silently change.

### 6.3 Resume / invalidation algorithm

1. Load checkpoint (or use in-memory state).
2. Diff partGraph revision r vs r+1 → changedParts, changedJoints.
3. invalidated = changed set ∪ dependents reachable via joint edges whose interface params changed.
4. Re-open invalidated steps' objections; for every untouched step recompute `inputsHash` and keep `satisfied` verdicts cached on hash match — **no critic re-run**. Green steps stay green by proof, not assumption.
5. cursor = min(stepIndex over invalidated), attempt = 1; clear that step's oscillation window and failure counters (new plan = fresh repair budget).
6. Enter BUILD. Assembly-level critics (buoyancy, assembly-clearance sweep) re-run only at milestones: after the last step, and after any resume touching ≥2 parts.

Plan steps are cut at **joint granularity** — a joint step owns *both* mating interface features (tail knuckles AND body-side boss) — so invalidating a joint invalidates exactly one step. This is CDCL-style non-chronological backjumping with objections as learned clauses; it is what makes "pick up where it got stuck" literally true.

---

## 7. Worked example: the pool fish

Goal: *"a fish I can 3D print in parts, assemble, and float in my pool."* Reference design: **300 × 110 × 70 mm PETG fish**, ellipsoid envelope, 9 printed parts all under a 130 mm footprint on a 220 × 220 mm bed, bonded with epoxy tongue-and-groove joints, no metal fasteners.

### 7.1 Part list

| Part | Approx dims | Qty | Notes |
|---|---|---|---|
| Hull-front (head + chamber A) | 130 × 110 × 70 mm | 1 | sealed chamber |
| Hull-mid (chamber B + ballast tank + fin slots) | 120 × 110 × 70 mm | 1 | ~300 mL ballast tank |
| Hull-rear (taper + hinge clevis) | 90 × 80 × 55 mm | 1 | |
| Tail + caudal fin (sealed hollow) | 90 × 85 × 12 mm | 1 | near-neutral buoyancy; fin membrane 0.8–1.2 mm |
| Hinge pin | Ø6 × 50 mm | 2 | one spare; PETG, 100% infill, printed standing |
| Ballast plug | M20×2.5, Ø26 × 15 mm | 1 | printed thread |
| Dorsal fin | 70 × 45 × 6 mm, solid | 1 | |
| Pectoral fins | 45 × 25 × 5 mm, solid | 2 | |
| RTV gasket | Ø22 × 2 mm | 1 | cast in a printed mold |

### 7.2 Buoyancy math (verified)

- Envelope: ellipsoid semi-axes 150 × 55 × 35 mm → V = (4/3)π·150·55·35 = **1.210 L**; at 50% draft, **0.605 L** displaced → all-up floating mass target **605 g** (design ρ_w = 1.00 g/cm³; real pool water is 0.994–0.999 g/cm³ over 15–35 °C — corrected — a 1–4 g difference absorbed by ballast trim).
- Immersion map (exact for any ellipsoid, upright): V(h)/V = (h/H)²(3 − 2h/H); floating at 40/50/60% of body height = 35.2/50/64.8% of volume submerged → target mean density **0.35–0.65 g/cm³**.
- Sealed-air requirement: with PETG at 1.27 g/cm³, air = 1 − f_vol·(ρ_w/1.27) gives **48.8–72.4%** of the envelope as the *plastic-only upper bound* (60.6% at even keel). **As designed** — with ~300 mL water ballast aboard at 50% draft — the sealed-air fraction is **~55–56%** (corrected; a validator pinned to 60.6% would flag a correct build).
- Printed structure: Thomsen ellipsoid area ≈ **696 cm²** (corrected from 740) × 2.4 mm wall × 1.27 g/cm³ ≈ **210 g** shell (corrected from 226); + flanges/bulkheads/fins ≈ 95 g → **≈ 300–310 g** structure (±15% — the mass-budget validator uses the real mesh volume, not this estimate).
- Ballast: 605 g − structure ≈ **295–305 g** ≈ 300 mL pool water via the belly port (or ~185 cm³ glass pebbles at 1.6 g/cm³ bulk), **trimmed in situ against the waterline** — the waterline, not a scale, is the acceptance criterion.

Solid prints sink (PLA 1.24, PETG 1.27 g/cm³). Buoyancy comes only from **explicitly modeled sealed CSG chambers** — never low infill: infill lattices interconnect and flood through perimeter micro-voids and thermal breathing, and the lost buoyancy is permanent and uncomputable. Three independent chambers cap a single-leak loss at ~35% of reserve. Thermal breathing on a sealed chamber: ±10 kPa over a 30 °C day-night swing (a floor — sun-heated dark surfaces can push ~13–15 kPa), versus only ~2 kPa depth pressure at 0.2 m: this is why the seal coat and curved (no large flat) panels are mandatory.

### 7.3 Material choice

**PETG** hull and chambers (hydrolysis-resistant copolyester; unaffected by pool chemistry of 1–3 ppm free chlorine, pH 7.2–7.8, 15–35 °C; best interlayer sealing), pigmented filament + exterior UV topcoat. Water absorption 0.1–0.2% at 24 h, ~0.5–0.9% at multi-year saturation (corrected — still <3 g on this structure); immersion longevity is *expected seasons-scale but unproven* — field anecdotes, not a materials rating. ASA optional for above-waterline fins. **Rejected:** PLA (hydrolyzes, Tg ~60 °C sun-softens), POM (documented brittle field failures at drinking-water chlorine levels), nylon (8–10% saturation swell — seizes). Generic chemical-resistance tables rate *saturated* chlorine water and will mislead a naive research branch into rejecting PETG; the research step must normalize concentration (1–3 ppm vs saturated) before acting.

Adhesives: 2-part epoxy (JB Weld MarineWeld / West System 105-207) for all structural joints after 220-grit sand + IPA wipe; neutral-cure RTV silicone only as ballast-port gasket and keyed seam sealant (never load-bearing — it barely adheres to PETG); CA for tacking **only** — it bonds PETG convincingly, then hydrolyzes white and lets go within weeks underwater. This is the likeliest field failure; documentation must be blunt.

### 7.4 Watertightness spec

5 perimeters × 0.5 mm extrusion width = **2.4–2.5 mm wall** (floors: 3 perimeters/1.2 mm elsewhere), flow multiplier 1.05–1.08, 0.2 mm layers (0.15 mm on chamber roofs), nozzle 245–250 °C, bed 80 °C, z-seam aligned to a rear spine, then **two brush coats of unfilled epoxy (150–300 µm total, 72 h cure before immersion)** — bare FDM walls seep grams/day through z-seams and inter-bead voids; the coat is what makes months. Per-chamber acceptance test before bonding: 24 h submerged at 0.3 m, pass if mass gain < 0.5 g on a 0.1 g scale — **against a pre-soaked baseline**, since virgin PETG absorbs 0.2–0.5 g in its first 24 h and would fail a naive reading **(to validate empirically)**.

### 7.5 Joints and clearances

Tail articulation: separate-pin **clevis hinge**, vertical axis, Ø6 × 50 mm PETG pin (100% infill, printed standing) or cut 6 mm HDPE rod, **radial clearance 0.35 ± 0.1 mm** (validator band 0.25–0.5 mm — deliberately loose, ~1 extrusion width, because the joint lives wet, coated, and fouling), ±28° printed stops, snap-cap retainers with a dab of silicone, food-grade silicone grease. The near-neutral sealed tail lets 1–3 Hz pool wavelets (physically grounded: deep-water dispersion gives 1.25–2.8 Hz for 0.2–1 m ripples) drive a visible wag. **Print-in-place is rejected**: its trapped 0.4–0.5 mm clearance cannot be epoxy-coated without seizing, it collects biofilm, and it is unserviceable — the fitted pin is replaceable (hence the printed spare). Monthly fresh-water rinse of the hinge; biofilm/scale slows the wag within 4–8 weeks otherwise.

Seams: 2 × 2 mm tongue-and-groove flanges; ≥2 asymmetrically placed Ø4.0 mm pins in Ø4.4 × 4.5 mm sockets per seam (registration ±0.2 mm, extra socket depth = glue pocket, asymmetry makes mis-assembly geometrically impossible); glue channel 1.0 × 0.6 mm inset 1.5 mm with ≥1.5 mm outer land and a 1 mm vent (prevents hydraulic lock); 0.4 mm × 45° witness chamfers on both seam edges. Every glue seam is modeled as a **virtual layer plane**: 50% of XY strength, zero cyclic tension allowed — one strength critic covers both print orientation and part splitting.

### 7.6 Split-for-bed

Three hull sections keep every footprint ≤ 130 mm on the 220 × 220 mm bed. Each cut plane becomes the piece's bed face (prints support-free, mating surface at first-layer flatness), flange-down, chamber roofs arched ≤ 45° self-supporting (no internal supports are possible in a sealed cavity). Cut planes stay ≥ 10 mm from the hinge and any flexure; cut-to-surface angle ≥ 30° (no feather edges). General splitting rule (corrected): piece count is computed **after** choosing orientation — divisor 240 mm for the Z-mapped axis, the oriented (rotated-diagonal) footprint for XY, with the diagonal bound **L + W ≤ 280 mm** on a 200 mm usable width (corrected from 300, which violated the margin the envelope itself established); `ceil(dim/200)` is only an upper bound and demands phantom cuts.

### 7.7 Assembly steps

1. Leak-test each chamber (§7.4).
2. Mask hinge bores and gasket faces; epoxy-coat all parts, 2 coats.
3. Bond hull-front to hull-mid: sand, IPA, epoxy in the groove, tape-clamp 24 h.
4. Bond hull-rear likewise; epoxy-fillet all seams. (Wash amine blush between coats — water + Scotch-Brite — or the second coat under-adheres.)
5. Fit tail, insert pin, snap caps.
6. Epoxy fins into slots.
7. Exterior UV topcoat; 72 h cure.
8. Float in pool; syringe water into the ballast tank until the waterline sits at 50% body height; grease and seat the plug.
9. Maintenance: monthly fresh-water hinge rinse, annual recoat and ballast re-trim. Optional printed belly eyelet + nylon tether keeps a free-floating 300 mm object out of the skimmer basket.

Testing and coating precede bonding because chamber interiors become unreachable; ballasting is last and in-pool because the waterline is the acceptance criterion.

### 7.8 Ballast and stability (corrected figures)

At 50% draft the closed forms give KB = 5c/8 = **34.4 mm**, BM_T = 3b²/(8c) = **8.3 mm**, KM_T = **42.7 mm** above keel.

- **Unballasted, the fish capsizes** — and the corrected number is worse than first computed: a ~305 g hull floats at only ~34% of body height (waterline ≈ 37 mm), where KB = 23.8 mm, BM = 12.6 mm, KM ≈ 36.5 mm against KG ≈ 55 mm → **GM_T ≈ −19 mm** (corrected from −12; the failure verdict stands either way).
- **Ballasted:** the tapered hull limits how low ballast can sit. Hull-conforming water fill (~300 mL) has centroid ≈ 22 mm → **GM_T ≈ +3 mm**; pebble ballast (~185 cm³) at centroid ≈ 17 mm → **GM_T ≈ +5.5 mm** (corrected from the original +8 mm, which required an unachievable 12 mm centroid). Validator: GM_T > 0 blocking, ≥ +5 mm advised — so prefer pebbles, or accept water fill with the tank *completely* full.
- Free-surface effect: a partially filled wall-sided tank costs ≈ **1.6 mm** of GM at any fill level — 20–50% of the entire margin. Fill fully or fit a 25 mm centerline baffle (cuts the penalty ~4× to ≈ 0.4 mm). Ballast is functional, not optional; the GM validator gates export.
- Pitch: GM_L ≈ **+150 mm** ballasted (corrected from +130, which used the unballasted KG) — overwhelming. Righting moment at 10° heel: **3–6 mN·m** at the realistic GM band.

### 7.9 Sample failure → research → resume trace

Plan rev 3, 11 steps; step 7 = joint J2, tail hinge, first planned as a Ø3.0 mm pin-socket (recipe in grammar: `cylinder 1.5 6`, moves/rotates).

- **Iter 12** — BUILD step 7, attempt 1 → CRITIQUE: clearance critic (C7, BVH closest-point pin↔socket) measures **0.00 mm radial** vs required ≥ 0.30 mm (FDM sliding fit) → **OBJ-17** opened, hint `{socket_d, +1, step 0.4}`. REPAIR: socket_d 3.0 → 3.4 mm.
- **Iter 13** — attempt 2 → CRITIQUE: clearance **0.20 mm**, still < 0.30 → OBJ-17 fails a 2nd consecutive time. Simultaneously the wobble critic opens **OBJ-18**: tail droop 4.1° vs ≤ 3.0°, implying radial clearance ≤ **0.25 mm** at this pin's 6 mm engagement. **S3 fires**: OBJ-17 needs ≥ 0.30, OBJ-18 needs ≤ 0.25 — empty interval → **STUCK**. Checkpoint `design_v9` written: cursor {step 7, attempt 2}, OBJ-17/18 open, progressTrace flat at P = 6.4.
- **RESEARCH** emits three questions (each carrying objectionIds): Q1 "joint types tolerating ≥ 0.30 mm play without droop, FDM, submerged" (→ OBJ-17, 18); Q2 "hinge clearance norms for printed-apart pool hinges, 0.4 mm nozzle PETG"; Q3 "must the tail swing for the float goal, or may it be rigid?" (waive candidate). Answers: droop is bounded by engagement geometry, not clearance alone — a long clevis span bounds droop ≈ atan(2c/L) to ~1.0° at 0.35 mm clearance over 40 mm; print-in-place is ruled out (trapped gap cannot be epoxy-coated without seizing, unserviceable in chlorinated water); the norm for printed-apart wet hinges is 0.25–0.5 mm radial with a replaceable pin; the swing is aesthetic (waivable if all else fails).
- **PlanDelta**: `editJoints` J2.type pin-socket → clevis-pin-hinge (Ø6 × 50 mm PETG pin, ±28° stops, snap-cap retainers); `removeParts` pin_tail (Ø3); `addParts` hinge pin ×2 (one spare); `addConstraints` radial clearance ∈ [0.25, 0.50] mm, droop ≤ 3.0°. Revision 3 → 4; ledger replay passes — the old contradictory bounds were superseded by the new joint type's constraint set, recorded in OBJ-17/18 history.
- **RESUME**: invalidated = {step 7} only, because J2's step owns both interface features; steps 1–6 and 8–11 keep hash-cached verdicts. Cursor = 7, attempt reset.
- **Iter 15** — BUILD step 7′ → CRITIQUE: radial clearance 0.36 mm ∈ [0.25, 0.50] → OBJ-17 satisfied {iter 15, rev 4}; droop 1.0° ≤ 3.0° → OBJ-18 satisfied. Steps 8–11 proceed on cached greens; assembly float critic passes (reserve buoyancy positive, GM_T +5 mm with pebble ballast). **DONE at iter 19.**

Totals: 2 failed attempts, 1 research round, **1 step rebuilt of 11, zero restarts**. The trace exercises every mechanism once — hint-driven repair, S3 infeasibility, checkpoint-on-STUCK, objection-anchored questions, a joint-type change confined to a PlanDelta, single-step invalidation, hash-cached greens — and is the acceptance test for the v1 implementation.

---

## 8. Implementation roadmap

Ordered into `src/engine/`, smallest shippable slice first; each slice lands with vitest coverage and leaves the app usable.

1. **`src/engine/ir/`** — IR schema + `ajv` validation + the expression evaluator. No geometry yet. Ships: IR documents parse, validate, diff (`fast-json-patch`), round-trip through design-doc v2 (`parseDesignDoc` dual-accepts v1/v2 — release this parser before any v2 writer).
2. **`src/engine/kernel/`** — manifold-3d in a Web Worker behind the §4.2 seam; primitives, extrude/revolve, booleans; the exporter assertion (Manifold-or-nothing); the arena/`delete()` discipline. Ships with the in-repo boolean benchmark (two procedural 100k-tri operands) that replaces the estimated timings.
3. **`src/engine/critics/` stage S0–S1** — C0, C1, C2 (typed-array edge counting), C3, C4a, C5 as pure functions `(scene, graph, step) -> Verdict[]`, plus the objection schema and verdict cache.
4. **`src/engine/engine.ts`** — the pure reducer, ledger, guards, S1–S5 stuck heuristics; tested on synthetic verdict streams, no three.js needed.
5. **Checkpointing** — the `corrective` block writer/loader on the three checkpoint triggers; resume/invalidation (§6.3).
6. **Joints** — macro-expansion of both mating solids from one spec, clearance table, joint-granularity plan steps; grammar productions (`pin`, `socket`, `dovetail`, `split`).
7. **Critics S2** — three-mesh-bvh worker, C6, C7.
8. **Research branch** — question templates, PlanDelta validation, NEEDS_USER UI path, plus the physical-experiment hook (tolerance coupon → machine-profile rewrite → resume).
9. **Critics S3** — C8, C9, C10 (buoyancy/GM), C4b (selective).
10. **The fish** — end-to-end: plan → 9 parts → critics → the §7.9 trace reproduced as an integration test → STL export.

Two new runtime dependencies total (`manifold-3d@3.5.1`, `three-mesh-bvh@^0.9.14`, both verified current on npm 2026-08-17), plus dev-side `ajv` and `fast-json-patch`. Pin against `three@^0.180` and CI-test before upgrading three (peer-range drift risk).

---

## 9. Research appendix

Verdict key: **✓** confirmed by verification · **✎** corrected (corrected figure shown; original discarded) · **~** estimate, to validate at integration · **?** uncertain **(to validate empirically)**.

### 9.A Kernel & performance

| Item | Value | V |
|---|---|---|
| manifold-3d version/license | 3.5.1 (2026-06-04), Apache-2.0 | ✓ |
| three-mesh-bvh version/license | 0.9.14 (2026-08-01), MIT | ✓ |
| three-bvh-csg watertight rate | 22 / 1000 boolean pairs (Polydera 2026) — preview only | ✓ |
| manifold-3d WASM payload | ~1.2–1.5 MB .wasm, ~400–600 KB compressed | ~ |
| Boolean, 2 × 100k tris, WASM single-thread | ~50–300 ms + 10–50 ms conversion each way | ~ |
| MeshBVH build | 100–250 ms / 100k tris (default CENTER strategy; SAH ~3–4× slower) | ✓ meas. |
| First-hit raycast, 100k-tri mesh | ~5–12 µs/ray (1–3 µs was optimistic) | ✎ meas. |
| C2 edge check | 30–80 ms / 100k tris with typed-array edge counting; Map impl ~2× slower | ✎ meas. |
| C3 mass properties | ~5 ms / 100k tris | ✓ meas. |
| C4b voxel backstop | 1–2.5 s in JS; pitch = max(0.2 mm, extent/256); 0.2 mm pitch valid only ≤ ~51 mm parts | ✎ meas. |
| C10 waterline solve | 15 bisection iterations, 0.15–0.45 s/assembly | ✓ meas. |
| Full suite | cold 2–5 s (C4b selective, ≤1–2 flagged parts); incremental 0.2–0.7 s | ✎ |
| Weld tolerance | 1e-3 mm, passed explicitly (three.js default is 1e-4 units); sits ~30–100× above float32 noise | ✓ (basis ✎) |
| Signed volume | V = (1/6) Σ dot(v0, cross(v1, v2)); float64, centroid-shifted; cross-check vs `manifold.volume()` at 1e-6 rel tol | ✓ |
| LLM free-form CAD compile rates | GPT-4 96.5%, Gemini 85%, CodeLlama 73.5% (CADPrompt) | ✓ |
| Checkpoint size | ~10–30 KB IR JSON for an 8–15 part model | ~ |

(Prior-art dataset sizes — DeepCAD ~178k models, Text2CAD ~170k annotations, etc. — are from memory and deliberately not load-bearing anywhere in this document.)

### 9.B Fits & design-for-printed-assembly (0.4 mm nozzle, 0.2 mm layers, 0.45 mm extrusion width, ±0.15 mm assumed scatter)

Fit ladder (diametral):

| Fit | Clearance | V |
|---|---|---|
| Press | −0.05…−0.15 mm — but scale interference to diameter: ~1–1.5% of D for PLA (≈0.05 mm at Ø3–5, 0.1–0.15 mm at Ø8–10), ~2× for PETG (0.2 mm only near Ø10) | ✎ |
| Snug | +0.05…+0.1 mm | ✓ |
| Sliding | +0.15…+0.2 mm | ✓ |
| Running (pin-in-socket pivot) | +0.3…+0.4 mm | ✓ |
| Glue | +0.2…+0.3 mm | ✓ |
| Print-in-place | ≥ +0.4 mm XY, ≥ 0.4 mm (2 layers) Z | ✓ |
| Untestable | \|clearance\| < 0.1 mm → ERROR "below machine scatter, print coupon" — the designed RESEARCH trigger (15-min 6-step ladder coupon, −0.1…+0.4 mm in 0.1 steps, answer rewrites the machine profile) | ✓ |

Walls quantize to n × 0.45 mm (±0.1): cosmetic 0.45, structural 0.9, recommended 1.35, **watertight 1.8 mm** (4 perimeters — 1.6 was 4 × 0.40 and fell in the quantization dead zone, ✎) + 6 top/bottom layers (1.2 mm) + sealed seams. Press-fit socket wall ≥ **1.8 mm** (✎, same arithmetic). Snap arms: L/t ≥ 8 PLA / ≥ 5 PETG; allowable strain 0.5%/1.0% PLA (repeated/single), 1.5%/2.0% PETG; y_max = 2εL²/(3t) (L = 16, t = 1.2: PETG 2.1 mm, PLA 0.7 mm undercut); thickness **0.9–1.8 mm in steps {0.9, 1.35, 1.8}** (✎); root fillet r ≥ 0.5t (min 0.5 mm); taper to 50% tip thickness → ×1.64 deflection; width ≥ 3 mm; insertion face 25–35°, retention 45° releasable / 80–90° permanent; arm axis within 45° of Z = automatic ERROR (Z halves allowable strain). Snap cycle life PLA ≤ 10 / PETG ≥ 100 **(to validate empirically per filament)**.

Orientation doctrine: assume Z tensile = 50% of XY (measured PLA 63%, PETG as low as 41% with wide scatter); cyclic tension across layer planes **forbidden** (fatigue life ~5–20× shorter); load axis ≤ 30° to build plane, ERROR ≥ 45°; flexures flex in-plane — beam axis *and* deflection direction in XY, hinge axis parallel to Z: **the fish tail prints flat and swishes in-plane**. PETG flexure: t 0.9–1.2 mm, ε = t/(2R) ≤ 1% → R ≥ 50t, 10³–10⁴ cycles (order-of-magnitude); TPU 95A insert for a true living hinge (>10⁵ cycles).

Overhangs: support beyond 45° from vertical (WARN 45–55°, ERROR >55°); bridges ≤ 8 mm; horizontal holes ≤ Ø8 mm else teardrop (45° apex); 45° chamfers replace down-facing fillets; **no support contact on mating faces** (±0.3–0.5 mm scarring exceeds every fit band); elephant-foot chamfer 0.4 mm × 45° on bed-contact mating edges; vertical holes +0.2 mm Ø comp, horizontal +0.3 mm (machine profile records which layer owns each compensation — double-applying with the slicer is a real bug). Splitting: OBB ≤ usable envelope (200 × 200 × 240 mm on a 220 × 220 × 250 machine); diagonal rule **L + W ≤ 280 mm** (✎); piece count computed after orientation (Z divisor 240; ✎); heat-set M3: Ø4.0 × 6 mm hole (+~1 mm melt room in blind holes), boss OD ≥ 8 mm; filament dowel: 1.75 mm stock in Ø2.0 × 6 mm holes.

Machine profile ships as versioned JSON data (`{nozzle: 0.4, layer: 0.2, ew: 0.45, scatter: 0.15, usable: [200, 200, 240]}`) — users override data, not code.

### 9.C Pool-fish physics

| Item | Value | V |
|---|---|---|
| Pool water density, 15–35 °C | 0.994–0.999 g/cm³ (design at 1.00; saltwater pools +0.2–0.3%) | ✎ |
| PETG density | 1.27 g/cm³ solid; 1.22–1.25 printed at 100% infill | ✓ |
| Immersion map | V(h)/V = (h/H)²(3 − 2h/H); 40/50/60% height = 35.2/50/64.8% volume | ✓ |
| Envelope / displacement | 1.210 L; 0.605 L at 50% draft; 605 g target | ✓ |
| Sealed-air fraction | 48.8–72.4% plastic-only bound (60.6% even keel); **~55–56% as designed with ballast** | ✎ |
| Structure mass | shell ≈ 210 g (Thomsen area ≈ 696 cm²); total ≈ 300–310 g ±15% | ✎ |
| Ballast | ≈ 295–305 g; water fill or ~185 cm³ pebbles; trimmed in situ | ✎ |
| KB / BM_T / KM_T at 50% draft | 34.4 / 8.3 / 42.7 mm | ✓ |
| GM_T unballasted | ≈ −19 mm at its real ~34% draft — capsizes | ✎ |
| GM_T ballasted | +3 mm (water fill, centroid ≈ 22 mm) to +5.5 mm (pebbles, ≈ 17 mm); validator > 0 blocking, ≥ +5 mm advised | ✎ |
| Free-surface penalty | ≈ 1.6 mm at any partial fill; 25 mm baffle → ≈ 0.4 mm | ✓ |
| GM_L / RM at 10° | ≈ +150 mm; 3–6 mN·m | ✎ |
| Thermal breathing / depth head | ±10 kPa floor (up to ~13–15 kPa sun-heated) vs ~2 kPa at 0.2 m | ✓ |
| Leak test | < 0.5 g gain, 24 h at 0.3 m, 0.1 g scale, pre-soaked baseline | ? |
| PETG water absorption | 0.1–0.2% at 24 h; ~0.5–0.9% saturation; longevity seasons-scale, unproven | ✎ |
| POM in chlorinated water | brittle field failures at 0.5–2 ppm — banned; nylon excluded (8–10% swell) | ✓ |
| Hinge | Ø6 × 50 mm pin, 0.35 ± 0.1 mm radial (band 0.25–0.5 mm), ±28°, 1–3 Hz wavelet excitation | ✓ |
| Pool chemistry envelope | 1–3 ppm free chlorine (shock excursions ~10 ppm), pH 7.2–7.8, 15–35 °C | ✓ |
| Float criterion (generic goal) | mean density ≤ 0.9 g/cm³ = ≥10% reserve — a hard floor; a *visibly* floating fish wants 0.5–0.7 g/cm³ | ✓ |

### 9.D Open questions

1. **Real per-operation kernel timings** on this codebase (boolean, BVH build, suite totals) — the benchmark harness in roadmap step 2 replaces every ~-flagged number.
2. **Printer calibration**: the fit table and scatter assume a calibrated 0.4/0.2 machine; the tolerance-coupon flow must exist before the first real joint ships, or fits will fail physically while passing validators.
3. **Snap cycle life and glue allowables** (PLA ≤ 10 / PETG ≥ 100 cycles; ~5 MPa design shear) — sparse published FDM data; treat as WARN thresholds until the lab measures its own filaments **(to validate empirically)**.
4. **Leak-test protocol**: confirm the pre-soak baseline makes the 0.5 g / 24 h threshold discriminative against PETG's own 24 h absorption **(to validate empirically)**.
5. **PETG multi-season pool longevity** — expected but unproven; the annual-recoat maintenance step is the hedge.
6. **Coupled-constraint infeasibility**: S3 proves emptiness only for single scalars; decide whether v2 needs a small interval-arithmetic pass over pairs, or whether S1/S4 backstops suffice in practice.
7. **Critic fixed-point ordering**: watertightness and buoyancy interact (perimeters raise mean density), so the float critic re-runs after any wall repair — confirm the dependency-ordered suite converges in ≤2 passes on real models.
8. **Threaded/rotational assembly paths** (C9 is straight-line only) and true 3D edge fillets (opencascade.js question) — both deferred until a goal demands them.
