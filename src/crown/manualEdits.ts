import type { ToothFrame } from './geom'

/**
 * Brush edits that survive a redesign: each outer-surface vertex's offset
 * from the automatic design, in the tooth's own axes (mesial, occlusal,
 * buccal). A redesign on the same grid re-applies them to the new automatic
 * surface, so a sculpted cusp stays sculpted when contacts, clearance or the
 * material change; the result is re-checked like any edit.
 *
 * Arrays hold the outer grid's nu·nv vertices followed by the pole, xyz each.
 */

/** Offsets of `edited` from `auto`, in the frame's axes. */
export function editOffsets(auto: Float32Array, edited: Float32Array, frame: ToothFrame): Float32Array {
  if (auto.length !== edited.length) throw new Error('edited surface does not match the design')
  const out = new Float32Array(auto.length)
  const { mesial: m, occlusal: o, buccal: b } = frame
  for (let k = 0; k < auto.length; k += 3) {
    const dx = edited[k] - auto[k]
    const dy = edited[k + 1] - auto[k + 1]
    const dz = edited[k + 2] - auto[k + 2]
    out[k] = dx * m[0] + dy * m[1] + dz * m[2]
    out[k + 1] = dx * o[0] + dy * o[1] + dz * o[2]
    out[k + 2] = dx * b[0] + dy * b[1] + dz * b[2]
  }
  return out
}

/** `base` (a new automatic surface, world) plus the offsets, expressed in `frame`'s axes. */
export function applyOffsets(base: Float32Array, offsets: Float32Array, frame: ToothFrame): Float32Array {
  if (base.length !== offsets.length) throw new Error('saved edits are for a different grid')
  const out = new Float32Array(base.length)
  const { mesial: m, occlusal: o, buccal: b } = frame
  for (let k = 0; k < base.length; k += 3) {
    const a = offsets[k]
    const c = offsets[k + 1]
    const e = offsets[k + 2]
    out[k] = base[k] + a * m[0] + c * o[0] + e * b[0]
    out[k + 1] = base[k + 1] + a * m[1] + c * o[1] + e * b[1]
    out[k + 2] = base[k + 2] + a * m[2] + c * o[2] + e * b[2]
  }
  return out
}

/** Largest offset, mm (0 = no edits). */
export function maxOffset(offsets: Float32Array): number {
  let m = 0
  for (let k = 0; k < offsets.length; k += 3) m = Math.max(m, Math.hypot(offsets[k], offsets[k + 1], offsets[k + 2]))
  return m
}
