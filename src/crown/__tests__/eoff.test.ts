import { describe, expect, it } from 'vitest'
import { parseEoff } from '../eoff'

function eoff(verts: number[][], faces: number[][], extra = 8): ArrayBuffer {
  const head = new TextEncoder().encode('OFF BINARY\n')
  const buf = new ArrayBuffer(head.length + 12 + verts.length * 12 + faces.length * 14 + extra)
  new Uint8Array(buf).set(head)
  const v = new DataView(buf)
  let o = head.length
  v.setInt32(o, verts.length, true)
  v.setInt32(o + 4, faces.length, true)
  v.setInt32(o + 8, 0, true)
  o += 12
  for (const p of verts) for (const c of p) (v.setFloat32(o, c, true), (o += 4))
  for (const f of faces) {
    v.setUint16(o, 3, true)
    f.forEach((i, k) => v.setUint32(o + 2 + k * 4, i, true))
    o += 14
  }
  return buf
}

describe('exocad .eoff reader', () => {
  it('reads vertices and triangles (trailing per-vertex data ignored)', () => {
    const g = parseEoff(eoff([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], [[0, 1, 2], [0, 1, 3]]))
    expect(g.getAttribute('position').count).toBe(4)
    expect(Array.from(g.index!.array)).toEqual([0, 1, 2, 0, 1, 3])
    expect(g.getAttribute('position').getZ(3)).toBe(1)
  })
  it('rejects other files and bad indices', () => {
    expect(() => parseEoff(new TextEncoder().encode('solid x').buffer as ArrayBuffer)).toThrow(/eoff/)
    expect(() => parseEoff(eoff([[0, 0, 0]], [[0, 1, 2]]))).toThrow(/range/)
  })
})
