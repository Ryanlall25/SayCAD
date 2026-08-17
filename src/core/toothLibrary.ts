import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * SayCAD Phase 1 — procedural placeholder tooth library.
 *
 * Every crown is generated from three.js primitives + math (a deformed
 * SphereGeometry lattice), so there is zero license-encumbered anatomy data
 * in here. Shapes are deliberately simplified but recognizable per class:
 * incisors are flattened wedges with a thin incisal edge, canines taper to a
 * single cusp tip, premolars carry two cusps split by a mesiodistal groove,
 * molars carry a 2x2 cusp table with a cross groove.
 *
 * Geometry conventions (placement code depends on these):
 * - The cervical BASE sits at y = 0; the crown extends along +Y, so +Y is
 *   the occlusal direction.
 * - X is the mesiodistal axis; the bounding-box width along X equals
 *   `ToothSpec.defaultWidthMm` (within float precision).
 * - Z is the buccolingual axis (+Z is treated as buccal/labial).
 * - All dimensions are millimetres. Output is deterministic (no randomness).
 */

export type ToothType = 'incisor' | 'canine' | 'premolar' | 'molar'

/** One entry of the 32-tooth manifest (Universal numbering, 1–32). */
export interface ToothSpec {
  /** Universal tooth number: 1–16 upper right→left, 17–32 lower left→right. */
  number: number
  type: ToothType
  /** Average mesiodistal crown width in mm — the bounding-box X width of the built geometry. */
  defaultWidthMm: number
  arch: 'upper' | 'lower'
  /** Short display label, e.g. "#3 Molar". */
  label: string
}

/** Neutral ivory — suggested material color for library teeth. */
export const TOOTH_LIBRARY_COLOR = 0xf0ead9

/** Per-quadrant template, ordered from the midline outward (central incisor → third molar). */
const TYPES_FROM_MIDLINE: ToothType[] = [
  'incisor',
  'incisor',
  'canine',
  'premolar',
  'premolar',
  'molar',
  'molar',
  'molar'
]

/** Average mesiodistal widths (mm) from the midline outward, per arch. */
const UPPER_WIDTHS_MM = [8.5, 6.5, 7.6, 7.0, 7.0, 10.5, 10.5, 9.5]
const LOWER_WIDTHS_MM = [5.0, 5.5, 6.9, 7.0, 7.0, 11.0, 10.5, 10.0]

const TYPE_WORD: Record<ToothType, string> = {
  incisor: 'Incisor',
  canine: 'Canine',
  premolar: 'Premolar',
  molar: 'Molar'
}

/** Distance from the midline (0 = central incisor … 7 = third molar) for a Universal number. */
function midlineIndex(universalNumber: number): number {
  if (universalNumber <= 8) return 8 - universalNumber
  if (universalNumber <= 16) return universalNumber - 9
  if (universalNumber <= 24) return 24 - universalNumber
  return universalNumber - 25
}

/**
 * All 32 permanent teeth in Universal numbering order (1–32).
 * 1–16 sweep the upper arch right→left, 17–32 the lower arch left→right.
 */
export const TOOTH_MANIFEST: ToothSpec[] = Array.from({ length: 32 }, (_, i) => {
  const number = i + 1
  const arch: ToothSpec['arch'] = number <= 16 ? 'upper' : 'lower'
  const idx = midlineIndex(number)
  const type = TYPES_FROM_MIDLINE[idx]
  const widths = arch === 'upper' ? UPPER_WIDTHS_MM : LOWER_WIDTHS_MM
  return {
    number,
    type,
    defaultWidthMm: widths[idx],
    arch,
    label: `#${number} ${TYPE_WORD[type]}`
  }
})

// ---------------------------------------------------------------------------
// Procedural crown generator
// ---------------------------------------------------------------------------

interface CuspSpec {
  /** Cusp apex position in mm (mesiodistal). */
  x: number
  /** Cusp apex position in mm (buccolingual). */
  z: number
  /** Peak height added along +Y in mm. */
  height: number
  /** Gaussian falloff radius in mm. */
  sigma: number
}

interface GrooveSpec {
  /** Axis the groove RUNS along ('x' = mesiodistal groove, cut by |z| distance). */
  axis: 'x' | 'z'
  /** Depth subtracted along Y in mm. */
  depth: number
  /** Gaussian half-width of the groove in mm. */
  sigma: number
}

interface CrownParams {
  /** Body height in mm before cusp displacement. */
  heightMm: number
  /** Maximum buccolingual depth in mm. */
  depthMm: number
  /** Superellipse exponent: 2 = ellipse, higher = squarer cross-section. */
  squareness: number
  /** Height fraction where the occlusal cap starts rounding radially inward. */
  capStart: number
  /** Mesiodistal half-width multiplier over height fraction v ∈ [0,1]; must peak at exactly 1. */
  widthProfile: (v: number) => number
  /** Buccolingual half-depth multiplier over height fraction v ∈ [0,1]. */
  depthProfile: (v: number) => number
  cusps: CuspSpec[]
  grooves: GrooveSpec[]
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t))

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * Piecewise profile over height fraction v: ramps `cervical → 1` on [0, riseEnd],
 * plateaus at exactly 1 on [riseEnd, fallStart] (this is what pins the bounding-box
 * width to the spec width), then eases `1 → occlusal` on [fallStart, 1].
 */
function crownProfile(
  cervical: number,
  riseEnd: number,
  fallStart: number,
  occlusal: number
): (v: number) => number {
  return (v) => {
    if (v <= riseEnd) return lerp(cervical, 1, smoothstep(0, riseEnd, v))
    if (v <= fallStart) return 1
    return lerp(1, occlusal, smoothstep(fallStart, 1, v))
  }
}

function crownParams(spec: ToothSpec): CrownParams {
  const w = spec.defaultWidthMm

  switch (spec.type) {
    case 'incisor':
      // Flattened rounded wedge: ~7 mm thick at the cervical, tapering to a
      // ~1.4 mm incisal edge that keeps most of its mesiodistal width.
      return {
        heightMm: 10,
        depthMm: 7,
        squareness: 2.5,
        capStart: 0.9,
        widthProfile: crownProfile(0.7, 0.3, 0.55, 0.8),
        depthProfile: crownProfile(0.85, 0.2, 0.3, 0.2),
        cusps: [],
        grooves: []
      }
    case 'canine':
      // Like an incisor but both axes taper toward a single cusp tip.
      return {
        heightMm: 10,
        depthMm: 8,
        squareness: 2.5,
        capStart: 0.7,
        widthProfile: crownProfile(0.7, 0.25, 0.45, 0.12),
        depthProfile: crownProfile(0.85, 0.2, 0.4, 0.12),
        cusps: [],
        grooves: []
      }
    case 'premolar': {
      // Rounded box, two cusps (buccal slightly taller) split by a central
      // mesiodistal groove. Body 6.9 + ~1.2 mm cusps ≈ 8 mm total.
      const d = 8.5
      const cz = d * 0.2
      return {
        heightMm: 6.9,
        depthMm: d,
        squareness: 3.2,
        capStart: 0.85,
        widthProfile: crownProfile(0.72, 0.3, 0.6, 0.8),
        depthProfile: crownProfile(0.8, 0.3, 0.6, 0.78),
        cusps: [
          { x: 0, z: cz, height: 1.15, sigma: 1.5 },
          { x: 0, z: -cz, height: 0.95, sigma: 1.5 }
        ],
        grooves: [{ axis: 'x', depth: 0.55, sigma: 0.7 }]
      }
    }
    case 'molar': {
      // Wider rounded box, 2x2 cusp table with a cross groove.
      // Body 6.5 + ~1 mm cusps ≈ 7.5 mm total.
      const d = spec.arch === 'lower' ? 11 : 10.5
      const cx = w * 0.21
      const cz = d * 0.2
      const sigma = w * 0.16
      return {
        heightMm: 6.5,
        depthMm: d,
        squareness: 3.8,
        capStart: 0.85,
        widthProfile: crownProfile(0.72, 0.3, 0.65, 0.88),
        depthProfile: crownProfile(0.78, 0.3, 0.65, 0.85),
        cusps: [
          { x: -cx, z: cz, height: 1.05, sigma },
          { x: cx, z: cz, height: 1.0, sigma },
          { x: -cx, z: -cz, height: 0.9, sigma },
          { x: cx, z: -cz, height: 0.85, sigma }
        ],
        grooves: [
          { axis: 'x', depth: 0.5, sigma: 0.65 },
          { axis: 'z', depth: 0.5, sigma: 0.65 }
        ]
      }
    }
  }
}

/** Fraction of body height below which the cervical base rounds off to y = 0. */
const BASE_ROUND = 0.08

/** Occlusal-detail blend: cusps/grooves only shape the top of the crown. */
const detailWeight = (v: number): number => smoothstep(0.55, 0.92, v)

/**
 * Builds a deterministic placeholder crown for the given tooth spec.
 *
 * Conventions honored by the output:
 * - Cervical base at y = 0, crown along +Y (occlusal), bounding box min.y = 0.
 * - Bounding-box width along X equals `spec.defaultWidthMm` (mesiodistal).
 * - Z is buccolingual. Units are millimetres.
 * - Indexed, smooth-shaded (vertex normals computed), bounding box/sphere
 *   precomputed, well under 20k vertices.
 */
export function buildToothGeometry(spec: ToothSpec): THREE.BufferGeometry {
  const params = crownParams(spec)
  const halfWidth = spec.defaultWidthMm / 2
  const halfDepth = params.depthMm / 2

  // A sphere gives a seam-light, pole-capped quad lattice whose rings we
  // re-shape ring-by-ring; latitude sampling is densest at the poles, which
  // is exactly where the occlusal detail and base rounding need resolution.
  const geometry = new THREE.SphereGeometry(1, 48, 64)
  const position = geometry.attributes.position
  const exponent = params.squareness

  for (let i = 0; i < position.count; i++) {
    const sx = position.getX(i)
    const sy = position.getY(i)
    const sz = position.getZ(i)

    // Height fraction 0 (cervical) → 1 (occlusal).
    const v = clamp01((sy + 1) / 2)

    // Ring direction in the XZ plane; poles collapse to the crown axis.
    const ringRadius = Math.hypot(sx, sz)
    let dirX = 0
    let dirZ = 0
    if (ringRadius > 1e-8) {
      dirX = sx / ringRadius
      dirZ = sz / ringRadius
    }

    // Superellipse cross-section: radius along this direction so that
    // |x/a|^n + |z/b|^n = 1. n = 2 is an ellipse; higher n squares it off.
    const superRadius =
      ringRadius > 1e-8
        ? Math.pow(Math.abs(dirX) ** exponent + Math.abs(dirZ) ** exponent, -1 / exponent)
        : 0

    // Radial rounding: quarter-arc blend into the base (y = 0) and into the
    // occlusal cap, so both ends close smoothly instead of as hard rims.
    let round = 1
    if (v < BASE_ROUND) {
      const t = (BASE_ROUND - v) / BASE_ROUND
      round *= Math.sqrt(Math.max(0, 1 - t * t))
    }
    if (v > params.capStart) {
      const t = (v - params.capStart) / (1 - params.capStart)
      round *= Math.sqrt(Math.max(0, 1 - t * t))
    }

    const x = dirX * superRadius * round * halfWidth * params.widthProfile(v)
    const z = dirZ * superRadius * round * halfDepth * params.depthProfile(v)
    let y = v * params.heightMm

    // Occlusal detail: gaussian cusp bumps and groove cuts along Y.
    const weight = detailWeight(v)
    if (weight > 0) {
      let detail = 0
      for (const cusp of params.cusps) {
        const dx = x - cusp.x
        const dz = z - cusp.z
        detail += cusp.height * Math.exp(-(dx * dx + dz * dz) / (2 * cusp.sigma * cusp.sigma))
      }
      for (const groove of params.grooves) {
        const dist = groove.axis === 'x' ? z : x
        detail -= groove.depth * Math.exp(-(dist * dist) / (2 * groove.sigma * groove.sigma))
      }
      y += weight * detail
    }

    position.setXYZ(i, x, y, z)
  }

  // Weld the UV seam column and the pole fans so normals shade smoothly all
  // the way around (uv/normal attributes would block position-only merging).
  geometry.deleteAttribute('uv')
  geometry.deleteAttribute('normal')
  const welded = mergeVertices(geometry)
  geometry.dispose()

  welded.computeVertexNormals()
  welded.computeBoundingBox()
  welded.computeBoundingSphere()
  return welded
}
