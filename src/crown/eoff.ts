import * as THREE from 'three'

/**
 * Reader for exocad's binary OFF meshes (`.eoff`, as used by tooth
 * libraries): an ASCII "OFF BINARY" line, then little-endian
 * int32 vertexCount, faceCount, edgeCount; float32 xyz per vertex; per face
 * a uint16 corner count followed by that many uint32 indices. Anything after
 * the faces (per-vertex extras) is ignored. Only triangles are accepted.
 */
export function parseEoff(buffer: ArrayBuffer): THREE.BufferGeometry {
  const bytes = new Uint8Array(buffer)
  const nl = bytes.indexOf(10)
  const head = new TextDecoder().decode(bytes.subarray(0, Math.max(0, nl)))
  if (nl < 0 || !/^OFF BINARY/.test(head)) throw new Error('Not an exocad binary OFF (.eoff) file.')
  const view = new DataView(buffer)
  let o = nl + 1
  const nv = view.getInt32(o, true)
  const nf = view.getInt32(o + 4, true)
  o += 12
  if (nv <= 0 || nf <= 0 || o + nv * 12 + nf * 14 > buffer.byteLength) throw new Error('Truncated .eoff file.')
  const positions = new Float32Array(nv * 3)
  for (let i = 0; i < nv * 3; i++) positions[i] = view.getFloat32(o + i * 4, true)
  o += nv * 12
  const indices = new Uint32Array(nf * 3)
  for (let f = 0; f < nf; f++) {
    const n = view.getUint16(o, true)
    if (n !== 3) throw new Error(`Face ${f} has ${n} corners; only triangles are supported.`)
    for (let k = 0; k < 3; k++) {
      const v = view.getUint32(o + 2 + k * 4, true)
      if (v >= nv) throw new Error('Face index out of range in .eoff file.')
      indices[f * 3 + k] = v
    }
    o += 14
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setIndex(new THREE.BufferAttribute(indices, 1))
  g.computeVertexNormals()
  return g
}
