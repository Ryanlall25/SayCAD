import * as THREE from 'three'
import { frameIsMirrored, frameMatrix, type ToothFrame } from './geom'
import type { CrownGrid } from './grid'

/**
 * Stitches the outer and intaglio grids into one closed triangle mesh.
 *
 * Both grids share row 0 (the margin) vertex-for-vertex, so the solid is
 * watertight and 2-manifold by construction: every margin edge is used once
 * by the outer surface and once by the intaglio, every other edge twice
 * within its own surface. `checkWatertight` re-verifies that on the final
 * mesh anyway — the export gate relies on the check, not on the argument.
 */

export function gridTriangles(nu: number, nv: number, base: number, poleIndex: number, flip: boolean, out: number[]): void {
  const idx = (i: number, j: number): number => base + j * nu + (((i % nu) + nu) % nu)
  const tri = (a: number, b: number, c: number): void => {
    if (flip) out.push(a, c, b)
    else out.push(a, b, c)
  }
  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu; i++) {
      const a = idx(i, j)
      const b = idx(i + 1, j)
      const c = idx(i + 1, j + 1)
      const d = idx(i, j + 1)
      // du × dv outward: (a → b) is +θ, (a → d) is toward the pole.
      tri(a, b, c)
      tri(a, c, d)
    }
  }
  for (let i = 0; i < nu; i++) tri(idx(i, nv - 1), idx(i + 1, nv - 1), poleIndex)
}

/** Closed crown solid in tooth-local coordinates. */
export function stitchSolid(outer: CrownGrid, intaglio: CrownGrid): { positions: Float32Array; indices: Uint32Array } {
  const { nu, nv } = outer
  if (intaglio.nu !== nu || intaglio.nv !== nv) throw new Error('outer and intaglio grids must match')
  // Vertex layout: outer rows 0..nv-1, outer pole, intaglio rows 1..nv-1, intaglio pole.
  const nOuter = nu * nv
  const nInner = nu * (nv - 1)
  const positions = new Float32Array((nOuter + 1 + nInner + 1) * 3)
  positions.set(outer.pts)
  positions.set(outer.pole, nOuter * 3)
  positions.set(intaglio.pts.subarray(nu * 3), (nOuter + 1) * 3)
  positions.set(intaglio.pole, (nOuter + 1 + nInner) * 3)
  const indices: number[] = []
  gridTriangles(nu, nv, 0, nOuter, false, indices)
  // Intaglio: same topology but row 0 maps onto the outer margin row, and the
  // winding flips so its normals face the prep (out of the solid).
  const innerBase = nOuter + 1
  const innerPole = nOuter + 1 + nInner
  const map = (v: number): number => {
    // v indexes a virtual nu×nv grid; row 0 → outer row 0.
    const j = Math.floor(v / nu)
    const i = v % nu
    return j === 0 ? i : innerBase + (j - 1) * nu + i
  }
  const virt: number[] = []
  gridTriangles(nu, nv, 0, nu * nv, true, virt)
  for (const v of virt) indices.push(v === nu * nv ? innerPole : map(v))
  return { positions, indices: Uint32Array.from(indices) }
}

/** World-space BufferGeometry for a local-space solid (handles mirrored frames). */
export function solidToWorld(local: { positions: Float32Array; indices: Uint32Array }, frame: ToothFrame): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(local.positions.slice(), 3))
  const idx = local.indices.slice()
  if (frameIsMirrored(frame)) {
    for (let t = 0; t < idx.length; t += 3) {
      const b = idx[t + 1]
      idx[t + 1] = idx[t + 2]
      idx[t + 2] = b
    }
  }
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  g.applyMatrix4(frameMatrix(frame))
  g.computeVertexNormals()
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

export interface WatertightReport {
  watertight: boolean
  boundaryEdges: number
  nonManifoldEdges: number
  inconsistentEdges: number
  /** Signed volume, mm³ (positive = outward-facing normals). */
  volumeMm3: number
}

/** Edge-incidence check + signed volume of an indexed mesh. */
export function checkWatertight(positions: ArrayLike<number>, indices: ArrayLike<number>): WatertightReport {
  const edges = new Map<number, { count: number; dir: number }>()
  const N = 4194304
  let volume = 0
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t], indices[t + 1], indices[t + 2]]
    for (let e = 0; e < 3; e++) {
      const a = v[e]
      const b = v[(e + 1) % 3]
      const key = a < b ? a * N + b : b * N + a
      const rec = edges.get(key) ?? { count: 0, dir: 0 }
      rec.count++
      rec.dir += a < b ? 1 : -1
      edges.set(key, rec)
    }
    const ax = positions[v[0] * 3], ay = positions[v[0] * 3 + 1], az = positions[v[0] * 3 + 2]
    const bx = positions[v[1] * 3], by = positions[v[1] * 3 + 1], bz = positions[v[1] * 3 + 2]
    const cx = positions[v[2] * 3], cy = positions[v[2] * 3 + 1], cz = positions[v[2] * 3 + 2]
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  let boundary = 0
  let nonManifold = 0
  let inconsistent = 0
  for (const rec of edges.values()) {
    if (rec.count === 1) boundary++
    else if (rec.count > 2) nonManifold++
    else if (rec.dir !== 0) inconsistent++
  }
  return {
    watertight: boundary === 0 && nonManifold === 0 && inconsistent === 0,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    inconsistentEdges: inconsistent,
    volumeMm3: volume
  }
}
