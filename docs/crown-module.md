# Crown module — `saycad.crown/1`

The crown designer is a **standalone module**. It owns everything about
designing a crown and nothing else: no patient database, no order system, no
billing, no user accounts. A host (the SmileHub suite, a lab system, a scanner
bridge) attaches through a **connector** and talks to it only through the
contract below.

```
 host ──── CrownJob ────▶  crown module  ──── CrownOutcome ────▶ host
 (order + scans)           intake checks → find prep → margin →   (crown STL, checks,
                           axis → anatomy → contacts/occlusion →    design record,
                           thickness → QC                           or what it needs)
 host ◀─── QcDecision ──── embedded studio (technician approves / edits / sends back)
```

Hosts depend only on `src/module/index.ts`. Everything else under `src/` is
internal and can change between versions.

## The contract

Defined in `src/module/contract.ts`. Every message carries
`contract: "saycad.crown/1"`.

**CrownJob** (what the host sends):

```json
{
  "contract": "saycad.crown/1",
  "jobId": "SH-2042-19",
  "order": { "tooth": 19, "system": "universal", "restoration": "crown",
             "material": "zirconia-hs", "shade": "A2", "caseRef": "SH-2042" },
  "scans": { "prep": <scan>, "antagonist": <scan>, "bite": [<scan>], "preop": <scan> },
  "options": { "tap": [x,y,z], "margin": [[x,y,z], …], "params": { … },
               "anatomy": { "lowerMolar": "<ssm json>" }, "alignInsertionToZ": true }
}
```

- `order.tooth` can be Universal (1–32) or FDI (`"system": "fdi"`, 11–48).
- Only `"crown"` restorations are designed so far.
- A scan is `{ name, data: ArrayBuffer }` holding STL/PLY bytes, or
  `{ name, mesh: { positions, indices } }`.
- `prep` is required. `antagonist` is strongly recommended, because it drives
  the contacts and is how the prep is found without a tap.
- `bite` and `preop` are recorded, not yet used.
- `options` are all optional:
  - `tap` or `margin`: where the prep is, when the host already knows.
  - `params`: design overrides.
  - `anatomy`: the lab's library or learned tooth models.
  - `alignInsertionToZ`: put the insertion axis on +Z for CAM.

**CrownOutcome** (what comes back):

| field | meaning |
|---|---|
| `status` | `designed` — a crown exists; `needs-input` — see `needs`, nothing was guessed; `failed` — `error` says why |
| `needs[]` | `{ kind: tooth \| scan \| prep-location \| margin \| restoration, message }` in plain words |
| `verdict` | `ready` (all checks pass) · `review` (warnings) · `blocked` (a check fails; approval needs a reason) |
| `checks[]` | every QC check with measured value, requirement and fix |
| `summary` | min axial / occlusal thickness, mesial / distal contact, occlusal clearance, volume, margin confidence |
| `intake[]` | scan problems found on arrival (wrong jaw by name, units, die instead of arch, not in the bite) |
| `prepFoundBy` | `bite` (found automatically), `host` (tap given or made in the studio), `margin-given` |
| `files` | `crownStl` (binary STL, one closed solid), `crownStlName`, `designRecord` (everything to audit or reproduce) |

**QcDecision** (from the technician, via the embedded studio):
`approved` · `edited` (approved after changes; `edits` holds the final
parameters and margin) · `rejected`. Hosts should store these. They are
the training signal that makes the module learn the lab's hand.

### Versioning

- `saycad.crown/1` only grows. New optional fields may be added; nothing is
  removed or changes meaning.
- A breaking change becomes `saycad.crown/2`, and the module keeps accepting
  `/1` for a deprecation period.
- `engine.version` on every outcome identifies the design engine that made it.

## Connectors

All four call the same `designCase()`.

### 1. In-process (JavaScript / TypeScript)

```ts
import { designCase, jobFromBundle, outcomeZip } from 'saycad/src/module'
const { job } = await jobFromBundle([{ name: 'case.zip', data }], { tooth: 19 })
const outcome = designCase(job!)              // runs in a worker or Node
```

Node builds use `npm run build:module`, which writes `dist-module/index.js`.

### 2. HTTP (server-to-server)

`node server/index.mjs` (after `npm run build:module`) exposes:

```
GET  /api/crown/v1                                  → { contract, ready, anatomy }
POST /api/crown/v1/design?tooth=19[&system=fdi][&material=…][&caseRef=…][&jobId=…][&alignZ=1]
     body: the case as a .zip  (scans + optional job.json / .dentalProject)
     → outcome JSON + links;   with  Accept: application/zip → the outcome files as a zip
GET  /api/crown/v1/jobs/<jobId>/<file>              → crown STL, outcome.json, design-record.json
```

- Jobs run in a worker thread, so the server stays responsive.
- Results are kept for one hour.
- Set `SAYCAD_ACCESS_CODE` and send it as `x-saycad-access`.
- Measured: a synthetic #19 case is designed in about 3.3 s per request.

### 3. Embedded studio (the suite's UI)

The suite puts the phone studio in an iframe and drives it with
`postMessage`:

```
<iframe src="https://<module>/?embed=1&host=https://<suite>">

studio → host  crown:ready
host → studio  crown:open    { job }            (scan ArrayBuffers are transferred)
studio → host  crown:outcome { outcome }        AI design done, or needs input
studio → host  crown:qc      { decision, outcome }   Approve & Send / Send Back
```

- The studio accepts messages only from the `host` origin in its URL, and
  posts only to that origin.
- The host side is `attachCrownStudio(iframe, studioOrigin, handlers)` in
  `src/module/embed.ts`.
- `dev/embed-host.html` is a working reference host in about 60 lines.
- Measured in `npm run e2e:embed`: case sent → outcome at the host in about
  7 s → Approve → QC decision with the 1.4 MB crown STL at the host.

### 4. Files and CLI (batch, folder drops, evaluation)

```
npm run crown -- design <case.zip | folder | files…> --tooth 19 [--fdi] [--material id] [--align-z] [--out dir]
npm run crown -- batch  <folder of cases> [--out dir]          # also writes batch.csv
```

A case bundle is a zip or folder of scans. Without a `job.json`, the scans
are matched by file name: upper/lower, maxillary/mandibular, `_u`/`_l`, bite,
pre-op.

- `job.json` can name the scans and the order.
- An exocad `.dentalProject` fills in the tooth and material.
- Request parameters override `job.json`, and `job.json` overrides the
  `.dentalProject`.

Batch mode is also the evaluation harness for running the lab's own cases.

## Status

- **Proven on synthetic cases:** all four connectors (unit tests,
  `e2e:embed`, CLI batch 5/5).
- **First real case (Laura, 3Shape):**
  - The scans read and sort correctly.
  - The module returns `needs-input` because several teeth are out of
    contact, rather than guessing.
  - The margin on the real prep is not yet accurate (about 1 mm off).
  - See `docs/crown-studio.md` §1.
- **Not in the module yet:**
  - bridges and other restorations (they return `needs-input: restoration`);
  - using the bite and pre-op scans;
  - a persistent job queue (the HTTP connector keeps results in memory).
