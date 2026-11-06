/**
 * Manual sculpting on a finished crown: one brush dab on the outer surface.
 *
 * The crown mesh's first nu·nv vertices are the outer grid (row 0 the margin,
 * rows toward the occlusal pole), so a dab moves those vertices in place and
 * the viewer redraws at once; the engine re-checks the edited surface when the
 * stroke ends (`reshape`). The margin row never moves, and the first rows
 * above it are eased in so a dab near the margin can't open a ledge there.
 */

export type BrushMode = 'add' | 'remove' | 'smooth' | 'flatten' | 'grab'

export interface BrushDab {
  mode: BrushMode
  /** World-space point under the cursor (on the crown surface). */
  center: [number, number, number]
  /** Brush radius, mm. */
  radiusMm: number
  /** add/remove: mm moved at the centre per dab; smooth/flatten: blend 0–1 per dab. */
  strength: number
}

const MARGIN_EASE_ROWS = 3

/** Smooth falloff: 1 at the centre, 0 at the radius (C¹ at both ends). */
export function falloff(d: number, r: number): number {
  if (d >= r) return 0
  const t = 1 - (d * d) / (r * r)
  return t * t
}

/** Per-vertex normals of the outer grid (area-weighted, from its quads). */
export function gridNormals(pos: ArrayLike<number>, nu: number, nv: number): Float32Array {
  const n = new Float32Array(nu * nv * 3)
  const P = (i: number, j: number, c: number): number => pos[(j * nu + (((i % nu) + nu) % nu)) * 3 + c]
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const j0 = Math.max(0, j - 1)
      const j1 = Math.min(nv - 1, j + 1)
      // du: along the ring (+θ); dv: toward the pole.
      const du = [P(i + 1, j, 0) - P(i - 1, j, 0), P(i + 1, j, 1) - P(i - 1, j, 1), P(i + 1, j, 2) - P(i - 1, j, 2)]
      const dv = [P(i, j1, 0) - P(i, j0, 0), P(i, j1, 1) - P(i, j0, 1), P(i, j1, 2) - P(i, j0, 2)]
      // Outward for the crown's winding (du × dv, see solid.ts).
      let x = du[1] * dv[2] - du[2] * dv[1]
      let y = du[2] * dv[0] - du[0] * dv[2]
      let z = du[0] * dv[1] - du[1] * dv[0]
      const l = Math.hypot(x, y, z) || 1
      x /= l
      y /= l
      z /= l
      const k = (j * nu + i) * 3
      n[k] = x
      n[k + 1] = y
      n[k + 2] = z
    }
  }
  // A mirrored tooth frame (left/right) reverses the winding: orient the
  // whole field outward, away from the grid's centroid.
  const cen = [0, 0, 0]
  for (let k = 0; k < nu * nv; k++) for (let c = 0; c < 3; c++) cen[c] += pos[3 * k + c] / (nu * nv)
  let s = 0
  for (let k = 0; k < nu * nv; k++) s += n[3 * k] * (pos[3 * k] - cen[0]) + n[3 * k + 1] * (pos[3 * k + 1] - cen[1]) + n[3 * k + 2] * (pos[3 * k + 2] - cen[2])
  if (s < 0) for (let q = 0; q < n.length; q++) n[q] = -n[q]
  return n
}

/**
 * Applies one dab to `pos` (the crown positions; only the first nu·nv
 * vertices change). Returns how many vertices moved and the largest move, mm.
 */
export function applyDab(pos: Float32Array, nu: number, nv: number, dab: BrushDab): { moved: number; maxMoveMm: number } {
  // Grab is a drag, not a dab: see applyGrab.
  if (dab.mode === 'grab') return { moved: 0, maxMoveMm: 0 }
  const { center: c, radiusMm: r } = dab
  const normals = gridNormals(pos, nu, nv)
  const w = new Float32Array(nu * nv)
  let any = false
  for (let j = 1; j < nv; j++) {
    const ease = j >= MARGIN_EASE_ROWS ? 1 : j / MARGIN_EASE_ROWS
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i
      const d = Math.hypot(pos[3 * k] - c[0], pos[3 * k + 1] - c[1], pos[3 * k + 2] - c[2])
      const f = falloff(d, r) * ease
      if (f > 0) {
        w[k] = f
        any = true
      }
    }
  }
  if (!any) return { moved: 0, maxMoveMm: 0 }

  const delta = new Float32Array(nu * nv * 3)
  if (dab.mode === 'add' || dab.mode === 'remove') {
    const s = dab.mode === 'add' ? dab.strength : -dab.strength
    for (let k = 0; k < nu * nv; k++) {
      if (!w[k]) continue
      for (let c3 = 0; c3 < 3; c3++) delta[3 * k + c3] = normals[3 * k + c3] * s * w[k]
    }
  } else if (dab.mode === 'smooth') {
    const blend = Math.min(1, Math.max(0, dab.strength))
    const P = (i: number, j: number, c3: number): number => pos[(j * nu + (((i % nu) + nu) % nu)) * 3 + c3]
    for (let j = 1; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = j * nu + i
        if (!w[k]) continue
        const jn = Math.min(nv - 1, j + 1)
        for (let c3 = 0; c3 < 3; c3++) {
          const avg = (P(i - 1, j, c3) + P(i + 1, j, c3) + P(i, j - 1, c3) + P(i, jn, c3)) / 4
          delta[3 * k + c3] = (avg - pos[3 * k + c3]) * blend * w[k]
        }
      }
    }
  } else {
    // Flatten: toward the weighted best-fit plane of the brushed area.
    const blend = Math.min(1, Math.max(0, dab.strength))
    let sw = 0
    const m = [0, 0, 0]
    const nrm = [0, 0, 0]
    for (let k = 0; k < nu * nv; k++) {
      if (!w[k]) continue
      sw += w[k]
      for (let c3 = 0; c3 < 3; c3++) {
        m[c3] += pos[3 * k + c3] * w[k]
        nrm[c3] += normals[3 * k + c3] * w[k]
      }
    }
    for (let c3 = 0; c3 < 3; c3++) m[c3] /= sw
    const nl = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1
    for (let c3 = 0; c3 < 3; c3++) nrm[c3] /= nl
    for (let k = 0; k < nu * nv; k++) {
      if (!w[k]) continue
      const off = (pos[3 * k] - m[0]) * nrm[0] + (pos[3 * k + 1] - m[1]) * nrm[1] + (pos[3 * k + 2] - m[2]) * nrm[2]
      for (let c3 = 0; c3 < 3; c3++) delta[3 * k + c3] = -nrm[c3] * off * blend * w[k]
    }
  }

  let moved = 0
  let maxMove = 0
  for (let k = 0; k < nu * nv; k++) {
    const dx = delta[3 * k]
    const dy = delta[3 * k + 1]
    const dz = delta[3 * k + 2]
    const l = Math.hypot(dx, dy, dz)
    if (l < 1e-7) continue
    pos[3 * k] += dx
    pos[3 * k + 1] += dy
    pos[3 * k + 2] += dz
    moved++
    maxMove = Math.max(maxMove, l)
  }
  return { moved, maxMoveMm: maxMove }
}

/**
 * Grab (exocad's free-form "move"): the surface within `radiusMm` of the
 * anchor follows a translation, weighted by the falloff measured on the
 * surface as it was when the grab started. `from` is that original surface;
 * `pos` gets from + t·w. The margin row stays put and the rows above it ease in.
 */
export function applyGrab(from: Float32Array, pos: Float32Array, nu: number, nv: number, anchor: [number, number, number], t: [number, number, number], radiusMm: number): { moved: number } {
  let moved = 0
  for (let j = 0; j < nv; j++) {
    const ease = j === 0 ? 0 : j >= MARGIN_EASE_ROWS ? 1 : j / MARGIN_EASE_ROWS
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i
      const d = Math.hypot(from[3 * k] - anchor[0], from[3 * k + 1] - anchor[1], from[3 * k + 2] - anchor[2])
      const w = falloff(d, radiusMm) * ease
      pos[3 * k] = from[3 * k] + t[0] * w
      pos[3 * k + 1] = from[3 * k + 1] + t[1] * w
      pos[3 * k + 2] = from[3 * k + 2] + t[2] * w
      if (w > 0) moved++
    }
  }
  return { moved }
}
