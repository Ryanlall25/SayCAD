# Crown & bridge design: what technicians do, and how their CAD looks

Research for SayCAD's engine and Crown Studio UI, gathered from public exocad and 3Shape
tutorials (November 2026). Each rule below is tagged with the video it came from so it can be
re-checked.

**How it was gathered, and its limits.** YouTube refuses video streams to this cloud machine, so
each video was watched through its storyboard: the preview frames YouTube serves from `i.ytimg.com`.
That gives one frame every ~10 s at 160×90 (some videos 320×180). It shows each step's screen,
the tools in use and any burned-in subtitles. Spoken narration is not available; captions return
empty without a YouTube token. The rules are therefore what is visible or written on screen, not
everything each presenter said.
`dev/ytwatch.sh <video>` fetches the frames for any video.

## 1. The workflow every video follows

Both programs run the same order, and nearly every tutorial walks it step by step:

1. **Order**: tooth chart, restoration type per tooth, material, shade. (Aidite crown; exocad bridge)
2. **Margin**: detect, then correct with draggable control points or a brush. Checked on the
   die alone from several sides. (all)
3. **Insertion path**: arch view with an undercut colour map and an arrow; lean it until undercuts
   are none or small. Bridges use one common path. (Aidite; 7FY9; exocad bridge)
4. **Library and placement**: choose a library tooth that matches the neighbours, then
   position/scale/rotate it as a whole. (Aidite; 3Shape Smile Composer; rebel3d)
5. **Adapt to neighbours and antagonist**: contacts and occlusion are set automatically, then read
   off a colour map. (all)
6. **Free forming**: add / remove / smooth / carve with radius and strength; the colour map stays
   live while sculpting. (all exocad videos)
7. **Thickness check**: areas under the material minimum are highlighted and fixed, then contacts
   are re-checked. (Aidite crown)
8. **Finish / export**: final checklist, then mill or print. (Aidite crown & bridge)

rebel3d's summary of what matters most, in order: crown **size**, the **long axis** against the
arch, the **buccal corridor**, then **contacts**. "The more you do in the current step, the less
work in the subsequent steps." (cMnmZAFzotQ)

## 2. Design rules, by step

### Margin
- The line sits **on the boundary** of the finish line. It does not need to cover the edge. (Aidite crown)
- It must be smooth with no sharp corners; correct it with control points or a circular brush
  cursor. (Aidite checklist; GwczPul5-yY; 7FY9)
- The crown edge must meet the prep edge with no ledge. Aidite calls this adjusting the "step";
  on implant crowns "the edge [is set] to 0 to ensure there is no step". (Aidite crown; 3i-fTWEgUWw)
- Detection proposes the line automatically; a second candidate line is sometimes offered beside
  it. Edits pull a section of the line with a disc brush, zoomed in. (llFYzaHlNNk; Hw9HBLC3fB4; eLSPz_Cc_Ms)
- **If the margin line crosses an undercut, 3Shape turns it red to warn you.** (llFYzaHlNNk)
- Before the margin, scan noise at the finish line is cleaned and the margin "opened": gum
  trimmed back from the shoulder, the digital version of ditching a die. (FAmFFyoBXt0)

### Insertion path
- **No undercut, or only a small one**. The tooth should be evenly wrapped. (Aidite crown & bridge)
- A bridge has one common path for all abutments, set to "the best direction". (Aidite bridge checklist)
- 3Shape can take the current view as the path: rotate the scan to look down the intended axis,
  then press Set. The same panel shows how tall the restoration will be. (llFYzaHlNNk)

### Library choice and placement
- Choose the library tooth **similar to the adjacent teeth**. The units should **arrange smoothly**
  with them. (Aidite crown)
- Set size first, then the long axis against the rest of the arch, then the buccal line (buccal
  corridor). (rebel3d)
- On bridges, keep the **buccal ridges as consistent as possible** across units, and line up the
  buccal/lingual margins and the central sulcus. (Aidite bridge)
- While a tooth is being placed, the neighbours are tinted by their distance to it, so the
  contacts are judged during placement, not only after. (_cYGR2I6onM)
- 3Shape's library picker is a grid of tooth thumbnails; picking one swaps the proposal in place.
  (ki9vSi18I5w; 3p10NSwMR00)

### Contacts
- Read contacts on the colour map (green patch). Check from below too: "flip the model upside
  down". (rebel3d; KPj671)
- Molar contacts should be **broad**. To see and build one face-on, hide the neighbour, add
  material there, then confirm from occlusal with the neighbour semi-transparent. (N0YAjqyJARI)
- Re-check contacts after every later step, because thickness and occlusion fixes move them. (Aidite crown)
- The contact can be removed while sculpting; the contact step adds it back ("will be
  automatically compensated after contact adjustment"). (3i-fTWEgUWw)

### Occlusion
- Remove occlusal high points. This is repeated after each change. (Aidite crown & bridge)
- Aim for a few **small contact spots on the cusps and fossae** (3–4 on a molar). A large patch
  means too much contact. Penetration shows as a dark-blue or magenta spot and is removed with a
  small brush. (DbDnT2kwCT0; rebel3d; 7FY9; GBxFQh4bIbs)
- **Dynamic occlusion** comes after static: a virtual articulator (condylar inclination, Bennett
  angle, incisal table) moves the jaw through protrusion and laterotrusion. The interferences marked
  on the occlusal surfaces are reduced until only intended contacts remain. (L8wQ17T0nkA)
- The occlusal surface must not have an obvious cavity. (Aidite checklist)

### Free forming, posterior (Aidite crown & bridge)
1. Rough shape with **moderate strength, moderate range**, then smooth on a large scale.
2. Carve grooves with the **smallest range, pen tool, greatest strength**, preferably **along the
   library tooth's own grooves**.
3. Pull out the buccal depression so the buccal profile runs as one consistent curve from occlusal to neck.
4. Draw the height of contour on the buccal, then successive passes to build the buccal convexity.
5. Smooth any sharp area left by removal.

### Free forming, anterior (Aidite anterior bridge)
1. Line angles first, with a pen over a **large range**.
2. Incisal ridge with a **small strength**, the same way on the laterals.
3. Developmental (labial lobe) grooves with a small strength.
4. Finally smooth the marginal ridges on both sides; afterwards the line angles may be deepened again.
- Strengths are given as fractions: deepen the lingual marginal ridge "with 1/5 strength and a
  pen", "then smooth with 1/2 strength", "draw the axial marginal ridge with 1/2 strength".
  Check the anatomy from three sides (labial, incisal, proximal), and the incisal edge must not
  be too thick. (ClGeLbVqO8A; 6QEb4M4Bh-4)
- A **copy/mirror** tool can mirror the contralateral natural tooth as a reference shape. Aidite
  makes it the standard start for a single anterior: "select copy, select mirroring according to
  the jaw plane… then adapt". (H5o-8dknqbk; ClGeLbVqO8A) On SayCAD's lab cases the technicians' crowns did **not** follow the contralateral
  tooth (0.5–0.6 mm off when measured), so this belongs as a manual option, not the automatic default.

### Design for the mill
- Detail finer than the milling bur is wasted. A 5-axis mill uses a ~0.3 mm bur, so grooves finer
  than that can't be cut. (rebel3d)

### Thickness
- Show the areas under the material minimum in colour and fix them before finishing. Then re-check
  contacts. (Aidite crown)
- 3Shape reads thickness in a **cross-section (clip) view**: the crown is cut by a plane and the
  cut outline is drawn red against the die. (59X-GMonOrM)

### Bridges: arrangement, connectors, pontic
- The units are placed together and kept on one smooth buccal curve. (Aidite bridge; GBxFQh4bIbs)
- **Connectors**: each one's cross-section is shown live as a 2D profile in a strip under the view,
  coloured **green / orange / red** for meets minimum / borderline / too thin. In 3D they are
  coloured bands with draggable outline points. (3Shape KOWv6kXhLLo; QVgr-5Og9G0)
- Connector positions are draggable handles between units. (exocad o4cu-JYJoB8)
- **Pontic**: its underside should fill the ridge contact ("ensure the gum fundus is filled"), and
  the gingival embrasure should be closed "reasonably". 3Shape outlines the ridge-contact area red.
  (Aidite bridge; FFlxZ6Ad9rY)
- Afterwards the units are smoothed together as one piece.

### Final checklist (Aidite crown, verbatim intent)
Margin line smooth, no sharp edges · insertion path in the best direction · crown consistent with
the adjacent teeth · embrasures symmetric with the neighbours · customer's parameters met · gingival
embrasure closed reasonably · no obvious occlusal cavity.

## 3. UI patterns

| Pattern | Seen in | What it does |
|---|---|---|
| Numbered **wizard step list** with Back / Next | exocad (all) | The current step is highlighted; every decision lives in its step |
| **Floating tool window** per step, docked left | exocad, 3Shape | Only that step's tools; sliders for radius and strength |
| **Distance colour scale fixed along the top** | exocad | One rainbow legend with numbers, the same for every map |
| **Concentric colour bands** on occlusal surfaces | exocad bridge | Distance contours per unit; magenta core = penetration |
| **Per-scan visibility and transparency toggles** on a right-edge bar | exocad, 3Shape | Neighbours and antagonist go semi-transparent instead of hidden |
| **Landmark control points** (coloured spheres on cusps, fossae, ridges) | 3Shape Smile Composer | Drag one point and the anatomy morphs around it |
| **Transform box / rotation globe** around the proposal | 3Shape, exocad | Move/scale/rotate the whole tooth; Ctrl and circular drags rotate |
| **Contour curve with control points** | 3Shape | Drag the height-of-contour outline to reshape the axial profile |
| **Cross-section clip view** | 3Shape | Plane through crown and die; red outline shows thickness |
| **Connector cross-section strip** | 3Shape | Live 2D section per connector, green/orange/red |
| **Arrangement handles** per bridge unit, plus cones for connectors | exocad | Select a unit (it turns red); drag connector positions |
| **Brush cursor** (translucent disc or ring) | exocad | Shows radius; used for both the margin and free forming |
| **Right-click context menu** on the margin line | exocad | Re-detect, smooth, delete point |
| **Virtual articulator** dialog | exocad | Articulator settings plus a jaw-motion run that marks interferences |
| **Copy / mirror** tool | exocad | Mirror the contralateral tooth as a start or reference shape |
| **Floating Buccal / Lingual labels** in 3D | exocad (Aidite, rebel3d) | Keeps orientation clear at any angle |
| **Minimal-thickness shell** drawn inside a translucent crown | exocad | Thickness readable without a separate step |
| **2D diagrams** beside parameters | exocad model creation | A picture per setting, not just a number |
| **Material preview** (tooth colour instead of yellow) | exocad | Final look before export |
| **Margin turns red over an undercut** | 3Shape | Warns while the line is placed |
| **Set axis from the current view** | 3Shape | Look down the path, press Set |
| **Library thumbnail grid** | 3Shape | Swap the proposal's tooth shape in place |
| **Pre-op / wax-up overlay** | exocad | The situation or wax-up scan overlaid (cyan) to compare or copy shapes |
| **Neighbours tinted by distance during placement** | exocad | Contacts judged while moving the tooth |
| **Connector edited in a 2D pane** between the two units' profiles | 3Shape | Section shaped directly in 2D |

## 4. SayCAD Crown Studio today vs these tools

Built since this research (November 2026):
- **connector cross-sections**: each connector drawn to scale, with the gum and bite at their
  measured distances, the minimum area dashed inside, and a green / amber / red verdict with
  reasons (3Shape shows only the section);
- **see-through jaws**: prep jaw and opposing jaw each solid, see-through or hidden, still tappable
  when see-through; Buccal / Lingual / Mesial / Distal labels around the tooth (exocad labels
  only buccal and lingual);
- **sectional view**: the 3D view clipped buccolingually or mesiodistally at any position, plus a
  to-scale 2D section of crown, intaglio, prep and opposing tooth, with the thinnest wall and the
  closest bite point marked and measured (3Shape draws the outline only).

Crown Studio already had:
- the wizard rail (Scans → Margin → Axis → Anatomy → Adapt → Check → Export), each stage done
  automatically on the first pass;
- the margin: drag and tap, plus auto-detect;
- the undercut figure on the Axis step;
- library or textbook anatomy, with sliders for cusp height, groove depth, rotation and
  buccal/lingual contour;
- brushes: add, remove, smooth, flatten and grab, with undo;
- thickness, occlusion and contact distance maps with a legend;
- layer toggles and view presets;
- the bridge panel: pontic side, second abutment, connector size, and a connector report with area,
  gum and bite clearance;
- measurements pinned to the model, chat and voice commands, and an AI review.

Still missing, in suggested order (biggest value for the effort first):

1. **Margin warnings**: colour the margin red where it crosses an undercut along the chosen path.
2. **Set the insertion path from the current view.**
3. **Landmark handles** on cusp tips, fossae and marginal ridges. The engine already knows the cusp
   tips (`cuspTips`); dragging one would run the existing grab edit.
4. **Transform gizmo** for the whole crown (move, rotate, scale) in place of the rotation and shift sliders.
5. **Occlusal contact spots view**: show contacts as discrete spots with a count, flagging large patches.
6. **Bur-size check**: flag grooves narrower than the chosen mill bur, or smooth them away (0.3 mm default).
7. **Copy/mirror tool** for front teeth, offered as a manual option.
8. **Pre-op / wax-up overlay**: load the situation or wax-up scan and show it over the design.
9. **Margin cleaning**: trim scan noise and gum back from the shoulder before detection.
10. **Virtual articulator / dynamic occlusion**: the largest item, a jaw-motion model with
   protrusion and laterotrusion sweeps.

## 5. Videos watched

Frames were viewed for all 43 videos; long ones were sampled.

| Video | Channel | Length |
|---|---|---|
| [Aidite Exocad design guide: Single crown of posterior teeth](https://www.youtube.com/watch?v=6VeVnese14w) | Aidite | 8 min |
| [Aidite Exocad design guide: Posterior bridge design](https://www.youtube.com/watch?v=83Z67LuFa-A) | Aidite | 16 min |
| [Full Anatomical Crown Design](https://www.youtube.com/watch?v=3p10NSwMR00) | 3Shape Training Videos | 6 min |
| [3Shape Design: Single-Unit Crowns and Three-Unit Bridges (webinar)](https://www.youtube.com/watch?v=59X-GMonOrM) | Zahn Dental | 73 min |
| [Exocad Crown Design For Zirconia on Tooth 46](https://www.youtube.com/watch?v=7FY9jdZktNk) | Nik Abu Ubaidullah | 15 min |
| [Full Zirconia Crown #37](https://www.youtube.com/watch?v=9hHlgWKoI54) | Ratanician | 12 min |
| [Advanced 3-Unit Bridge Design #2–#4](https://www.youtube.com/watch?v=FFlxZ6Ad9rY) | KimDental | 5 min |
| [Aidite Exocad design guide: Anterior teeth bridge design](https://www.youtube.com/watch?v=Fkz95rEZzkE) | Aidite | 21 min |
| [Complete Anterior Crown Design in Exocad (11–21)](https://www.youtube.com/watch?v=H5o-8dknqbk) | Ratanician | 12 min |
| [Exocad Bridge Design For Zirconia on Tooth 24–27](https://www.youtube.com/watch?v=GBxFQh4bIbs) | Nik Abu Ubaidullah | 22 min |
| [Bridge Framework Design](https://www.youtube.com/watch?v=KOWv6kXhLLo) | 3Shape Training Videos | 5 min |
| [How To Get a "Zero-Adjustment" Design?](https://www.youtube.com/watch?v=KPj671-7OeM) | Rezident | 2 min |
| [EXOCAD tutorials: margin line how and why](https://www.youtube.com/watch?v=GwczPul5-yY) | AestheticDentalDesign Lab | 6 min |
| [ExoCAD Occlusal Adjustment](https://www.youtube.com/watch?v=L8wQ17T0nkA) | Dwight Pate | 26 min |
| [Exocad hack: better contact area in molars](https://www.youtube.com/watch?v=N0YAjqyJARI) | Dental digital excellence | 2 min |
| [exocad Video Tutorial: Designing a Three-Element Bridge](https://www.youtube.com/watch?v=o4cu-JYJoB8) | exocad GmbH | 31 min |
| [How to Design Bridge Connectors and Anatomical Copings with 3Shape](https://www.youtube.com/watch?v=tW7Tqsvv0Ro) | MAPTEC | 9 min |
| [Tooth placement & free forming in exocad](https://www.youtube.com/watch?v=hTfFvRnpSPI) | Chroma.Smile.Studio | 79 min (lightly sampled) |
| [Exocad Tutorial: 6-Unit Anterior Bridge](https://www.youtube.com/watch?v=lamCDwCSdLc) | Exocad Space | 10 min (lightly sampled) |
| [Knife-edge vertical crown in Exocad](https://www.youtube.com/watch?v=mkLDFie8d3U) | Marcin Nowosielski | 32 min (lightly sampled) |
| [5 Min Crown Design for Dentists in exocad](https://www.youtube.com/watch?v=cMnmZAFzotQ) | rebel3d | 24 min |
| [Exocad Crown design: Tooth 36](https://www.youtube.com/watch?v=DbDnT2kwCT0) | DT. Ray K | 6 min |
| [3Shape Tutorial: Full Contour Bridge](https://www.youtube.com/watch?v=QVgr-5Og9G0) | WIXUR Dental Academy | 23 min |
| [How to Make ANTERIOR Bridge look NATURAL](https://www.youtube.com/watch?v=AimPc1x3cHs) | Dental Class | 12 min |
| [Aidite Exocad design guide: Anterior teeth design](https://www.youtube.com/watch?v=ClGeLbVqO8A) | Aidite | 9 min |
| [Aidite Exocad design guide: Implant crown design](https://www.youtube.com/watch?v=3i-fTWEgUWw) | Aidite | 6 min |
| [Aidite Exocad design guide: Veneer design](https://www.youtube.com/watch?v=6QEb4M4Bh-4) | Aidite | 30 min (sampled) |
| [Performing a full anatomical crown design](https://www.youtube.com/watch?v=llFYzaHlNNk) | 3Shape Training Videos | 6 min |
| [Split Bridges Design](https://www.youtube.com/watch?v=LMbnfgGvxqo) | 3Shape Training Videos | 6 min |
| [Dental Lab Life: Designing a Crown in 3Shape](https://www.youtube.com/watch?v=ki9vSi18I5w) | Zahn Dental | 11 min (sampled) |
| [Crown Design Tips with 3Shape](https://www.youtube.com/watch?v=nO8LpNBq7Z8) | Dr. Agatha Bis Dentistry | 16 min (sampled) |
| [exocad Video Tutorial: Basic Features / Anatomic Coping with Cutback](https://www.youtube.com/watch?v=uGJD2RC4mJg) | exocad GmbH | 24 min (sampled) |
| [Bridge EXOCAD. 2024 Tutorial](https://www.youtube.com/watch?v=KRQ4hNbs08M) | Dental Class | 15 min (sampled) |
| [EXOCAD: Bridge Tutorial 2025](https://www.youtube.com/watch?v=ypYQtU8te28) | Dental Class | 17 min (sampled) |
| [CROWN Design EXOCAD. 2024 Tutorial](https://www.youtube.com/watch?v=_cYGR2I6onM) | Dental Class | 6 min |
| [Big ANTERIOR Case Tutorial EXOCAD 2025](https://www.youtube.com/watch?v=lG3NGKLQmvk) | Dental Class | 20 min (sampled) |
| [How to design a Bridge with ExoCad](https://www.youtube.com/watch?v=QczF9f6A3t8) | Z Digital Dentistry | 15 min (sampled) |
| [Exocad Digital Impression Preparation – Margin Opening & Cleaning](https://www.youtube.com/watch?v=FAmFFyoBXt0) | CaesarDentalArt | 13 min (sampled) |
| [Margin line Detection](https://www.youtube.com/watch?v=Hw9HBLC3fB4) | Khánh Dental Lab | 10 min (sampled) |
| [Detect / edit margins Exocad](https://www.youtube.com/watch?v=eLSPz_Cc_Ms) | GeorgeCampus | 11 min (sampled) |
| [Exocad Crown design: Tooth 25](https://www.youtube.com/watch?v=d8B9IYsh68g) | DT. Ray K | 3 min |
| [Exocad: Design perfect crown in 5 minutes](https://www.youtube.com/watch?v=SzXbCkBniJk) | Digiart Design Services | 5 min |
| [Anatomic Crown Design Exocad workflow](https://www.youtube.com/watch?v=rkhWp_C3Jz0) | MediMatch Dental Lab | 3 min |
