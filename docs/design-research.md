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
- The crown edge must meet the prep edge with no ledge. Aidite calls this adjusting the "step". (Aidite crown)

### Insertion path
- **No undercut, or only a small one**. The tooth should be evenly wrapped. (Aidite crown & bridge)
- A bridge has one common path for all abutments, set to "the best direction". (Aidite bridge checklist)

### Library choice and placement
- Choose the library tooth **similar to the adjacent teeth**. The units should **arrange smoothly**
  with them. (Aidite crown)
- Set size first, then the long axis against the rest of the arch, then the buccal line (buccal
  corridor). (rebel3d)
- On bridges, keep the **buccal ridges as consistent as possible** across units, and line up the
  buccal/lingual margins and the central sulcus. (Aidite bridge)

### Contacts
- Read contacts on the colour map (green patch). Check from below too: "flip the model upside
  down". (rebel3d; KPj671)
- Molar contacts should be **broad**. To see and build one face-on, hide the neighbour, add
  material there, then confirm from occlusal with the neighbour semi-transparent. (N0YAjqyJARI)
- Re-check contacts after every later step, because thickness and occlusion fixes move them. (Aidite crown)

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
4. Finally smooth the marginal ridges on both sides.
- A **copy/mirror** tool can mirror the contralateral natural tooth as a reference shape.
  (H5o-8dknqbk) On SayCAD's lab cases the technicians' crowns did **not** follow the contralateral
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

## 4. SayCAD Crown Studio today vs these tools

Crown Studio already has:
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

Missing, in suggested order (biggest value for the effort first):

1. **Connector cross-section display** (green/orange/red per connector). The data is already in the
   bridge report; this is a visual.
2. **Semi-transparent neighbours and antagonist** instead of only show/hide, plus floating
   Buccal/Lingual labels.
3. **Cross-section clip view**: a draggable plane through crown and die, with the cut outline coloured by thickness.
4. **Landmark handles** on cusp tips, fossae and marginal ridges. The engine already knows the cusp
   tips (`cuspTips`); dragging one would run the existing grab edit.
5. **Transform gizmo** for the whole crown (move, rotate, scale) in place of the rotation and shift sliders.
6. **Occlusal contact spots view**: show contacts as discrete spots with a count, flagging large patches.
7. **Bur-size check**: flag grooves narrower than the chosen mill bur, or smooth them away (0.3 mm default).
8. **Copy/mirror tool** for front teeth, offered as a manual option.
9. **Virtual articulator / dynamic occlusion**: the largest item, a jaw-motion model with
   protrusion and laterotrusion sweeps.

## 5. Videos watched

Frames were viewed for these 24 videos; long ones were sampled. Another 19 crown, bridge and margin
tutorials were found and downloaded but not yet reviewed.

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
