import { describe, expect, it } from 'vitest'
import { parseObj, parseScan } from './meshConvert'

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer

describe('OBJ scans', () => {
  it('reads vertex colour (0–255) and fans polygons into triangles', () => {
    const g = parseObj(enc('# scan\nv 0 0 0 255 128 0\nv 1 0 0 255 128 0\nv 1 1 0 0 0 255\nv 0 1 0 0 0 255\nvt 0 0\nf 1/1 2/1 3/1 4/1\n'))
    expect(g.getAttribute('position').count).toBe(4)
    expect(Array.from(g.index!.array)).toEqual([0, 1, 2, 0, 2, 3])
    const c = g.getAttribute('color')
    expect(c.getX(0)).toBeCloseTo(1)
    expect(c.getY(0)).toBeCloseTo(128 / 255)
    expect(c.getZ(3)).toBeCloseTo(1)
  })

  it('keeps 0–1 colour as is, and has no colour when vertices carry none', () => {
    expect(parseObj(enc('v 0 0 0 0.5 0.5 0.5\nv 1 0 0 0.5 0.5 0.5\nv 0 1 0 0.5 0.5 0.5\nf 1 2 3\n')).getAttribute('color').getX(0)).toBeCloseTo(0.5)
    expect(parseObj(enc('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n')).getAttribute('color')).toBeUndefined()
  })

  it('is picked by file name', () => {
    expect(parseScan('prep_jaw.OBJ', enc('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')).index!.count).toBe(3)
  })
})
