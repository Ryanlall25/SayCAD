# `.sih` — SmileHub case file (version 1)

**SIH = Super Intelligence Hub.** One file holds a whole dental case: the
scans, what each one is, the tooth and order, the design (margin, insertion
axis, tooth frame) and the finished restoration.

It is not a new mesh format. A `.sih` is a zip of standard files, so any part
of it still opens in exocad, 3Shape, Meshmixer, MeshLab, Blender or printer
software once it's unpacked. What no mesh format carries, the roles, tooth,
margin and axis, goes in one JSON manifest.

## Layout

```
case.sih  (zip)
├── sih.json              manifest — always the first entry
├── scans/<role>.ply      binary little-endian PLY, one per scan
├── design/crown.stl      binary STL of the finished restoration (optional)
├── design/record.json    design record: parameters, checks (optional)
└── extra/<name>          anything else kept with the case (optional)
```

- **Scans.** Each scan is stored as float32 x y z, then optional uchar
  red green blue, then int32 triangles. That's about a third the size of
  the same scan as OBJ text, and it keeps the scanner's colour.
- **One coordinate frame.** Every scan, the margin and the crown share one
  frame in millimetres, with the jaws already in occlusion. No registration
  step is needed.
- **Checksums.** `sih.json` lists every other file with its byte size and
  SHA-256. A reader refuses a case whose files don't match.

## `sih.json`

```json
{
  "format": "sih/1",
  "created": "2026-10-26T18:37:58.362Z",
  "generator": "SmileHub SayCAD",
  "units": "mm",
  "frame": "All scans, the margin and the crown share one coordinate frame, with the jaws in occlusion.",
  "case": { "id": "case03", "tooth": 30, "system": "universal", "restoration": "crown", "material": "zirconia-hs", "shade": "A2" },
  "scans": [
    { "role": "prep", "jaw": "lower", "source": "prep_jaw.obj + prep_die.obj", "file": "scans/prep.ply", "vertices": 83581, "triangles": 153867, "colour": true },
    { "role": "antagonist", "jaw": "upper", "file": "scans/antagonist.ply", "vertices": 93297, "triangles": 186590, "colour": true }
  ],
  "design": { "margin": [[x, y, z], ...], "insertionAxis": [x, y, z], "frame": { "origin": [...], "mesial": [...], "occlusal": [...], "buccal": [...] }, "crown": "design/crown.stl", "record": "design/record.json" },
  "extra": ["extra/case03.constructionInfo"],
  "files": [{ "path": "scans/prep.ply", "bytes": 1234, "sha256": "…" }]
}
```

**Scan roles:**

| Role | What it is |
|---|---|
| `prep` | The arch being restored (with the die set in, if there is one) |
| `antagonist` | The opposing arch |
| `bite` | A bite registration scan |
| `preop` | The pre-operative scan |
| `die` | The separated die |
| `raw-prep`, `raw-antagonist`, `raw-bite` | Untouched scanner exports |
| `other` | Anything else |

**Fields:**
- `jaw` (optional) is `upper` or `lower`.
- `case.system` is `universal` (the default) or `fdi`.
- `case.material` is free text; readers map common names such as "Zirconia"
  or "e.max" to their own presets.

**Versioning.** The major version is the number in `format`. A reader
refuses a major version it doesn't know. Within a version, new fields may
appear, and readers ignore what they don't use.

## Tools

- **App, New Crown:** "Have a .sih case or the whole scanner export? Import
  it" fills in the tooth, the material and every scan.
- **App, Export:** "Save Case (.sih)" writes the scans, tooth, margin,
  axis, crown and design record.
- **Module and HTTP API:** a `.sih` is a valid case bundle.
  `npm run crown -- design case.sih` designs from it, using its margin when
  it has one.
- **CLI:**
  - `npm run sih -- pack <case folder>` builds a `.sih` from a lab case
    folder (jaw scans, die, raw exports, crown STL, exocad `case.json`).
  - `npm run sih -- unpack <case.sih>` turns it back into plain PLY and STL
    files.
  - `npm run sih -- info <case.sih>` prints the contents and verifies every
    checksum.

## Limits (version 1)

- Files are stored without compression, so parts can be read straight out
  of the zip. The three exocad test cases came to 55–60 % of their folder
  size anyway, because binary PLY is much smaller than OBJ text.
- There is no ZIP64 support, so a case must stay under 4 GB.
- exocad and 3Shape don't open `.sih` directly; you import the PLY and STL
  files from inside it. 3Shape's encrypted `.dcm` scans can't be converted.
