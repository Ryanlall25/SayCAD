// Core geometry machinery for the fish generator — spec-independent.
// Proven pieces only: manifold-3d booleans/volume (smoke.mjs), closed lofts,
// binary STL out, and the validation gates every part must pass.
import Module from 'manifold-3d'
import { writeFileSync } from 'node:fs'

let wasm = null
export async function boot() {
  if (!wasm) {
    wasm = await Module()
    wasm.setup()
  }
  return wasm
}
export const M = () => wasm.Manifold
export const CS = () => wasm.CrossSection

/**
 * Closed loft through rings of vertices. Every ring must have the same vertex
 * count; degenerate ends are handled by collapsing to a centroid fan so the
 * result is watertight. Rings are arrays of [x,y,z]; consecutive rings are
 * stitched with quads (as two triangles), wound outward assuming rings are
 * counter-clockwise viewed from +Z (along the fish, nose to tail).
 */
export function loft(rings) {
  const n = rings[0].length
  for (const r of rings) if (r.length !== n) throw new Error('ring vertex counts differ')
  const verts = []
  const tris = []
  const idx = (i, j) => i * n + (j % n)
  for (const ring of rings) for (const [x, y, z] of ring) verts.push(x, y, z)

  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = idx(i, j), b = idx(i, j + 1), c = idx(i + 1, j), d = idx(i + 1, j + 1)
      tris.push(a, b, d, a, d, c)
    }
  }
  // End caps: centroid fans (nose cap faces -Z, tail cap faces +Z)
  const centroid = (ring) => {
    const s = [0, 0, 0]
    for (const v of ring) { s[0] += v[0]; s[1] += v[1]; s[2] += v[2] }
    return s.map((x) => x / ring.length)
  }
  const c0 = verts.length / 3
  verts.push(...centroid(rings[0]))
  for (let j = 0; j < n; j++) tris.push(c0, idx(0, j + 1), idx(0, j))
  const c1 = verts.length / 3
  verts.push(...centroid(rings[rings.length - 1]))
  const last = rings.length - 1
  for (let j = 0; j < n; j++) tris.push(c1, idx(last, j), idx(last, j + 1))

  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties: new Float32Array(verts),
    triVerts: new Uint32Array(tris)
  })
  mesh.merge()
  const m = new wasm.Manifold(mesh)
  if (m.status().value !== 0 && String(m.status()) !== 'NoError')
    throw new Error(`loft not manifold: ${JSON.stringify(m.status())}`)
  return m
}

/** Elliptical ring in the XY plane at height z: rx wide (x), ry tall (y). */
export function ellipseRing(rx, ry, z, n = 64, yOffset = 0) {
  const ring = []
  for (let j = 0; j < n; j++) {
    const t = (j / n) * Math.PI * 2
    ring.push([rx * Math.cos(t), ry * Math.sin(t) + yOffset, z])
  }
  return ring
}

/** Binary STL from a Manifold. Returns byte length. */
export function writeSTL(manifold, path, name = 'saycad fish part') {
  const mesh = manifold.getMesh()
  const tri = mesh.triVerts.length / 3
  const buf = Buffer.alloc(84 + tri * 50)
  buf.write(name.slice(0, 78), 0, 'latin1')
  buf.writeUInt32LE(tri, 80)
  let off = 84
  const P = mesh.vertProperties
  const np = mesh.numProp
  for (let t = 0; t < tri; t++) {
    const a = mesh.triVerts[3 * t] * np, b = mesh.triVerts[3 * t + 1] * np, c = mesh.triVerts[3 * t + 2] * np
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]]
    const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]
    const nv = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const len = Math.hypot(...nv) || 1
    for (const x of [nv[0] / len, nv[1] / len, nv[2] / len, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]) {
      buf.writeFloatLE(x, off)
      off += 4
    }
    buf.writeUInt16LE(0, off)
    off += 2
  }
  writeFileSync(path, buf)
  return { triangles: tri, bytes: buf.length }
}

/** Validation gates. Returns {ok, checks:[{gate, ok, detail}]}. */
export function validate(part, { name, plate = [130, 80, 155], maxVolume = null } = {}) {
  const checks = []
  const status = String(part.status()?.value ?? part.status())
  checks.push({ gate: 'manifold', ok: status === '0' || status === 'NoError', detail: `status=${status}` })
  const bb = part.boundingBox()
  const dims = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]]
  const sorted = [...dims].sort((a, b) => a - b)
  const plateSorted = [...plate].sort((a, b) => a - b)
  const fits = sorted.every((d, i) => d <= plateSorted[i] + 1e-6)
  checks.push({ gate: 'plate-fit', ok: fits, detail: `part ${dims.map((d) => d.toFixed(1)).join('×')}mm vs plate ${plate.join('×')}` })
  const props = part.getProperties ? part.getProperties() : { volume: part.volume() }
  checks.push({ gate: 'volume', ok: props.volume > 0 && (maxVolume === null || props.volume <= maxVolume), detail: `${(props.volume / 1000).toFixed(1)} cm3` })
  return { name, ok: checks.every((c) => c.ok), checks, dims, volume: props.volume }
}
