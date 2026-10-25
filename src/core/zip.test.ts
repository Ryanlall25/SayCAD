import { describe, expect, it } from 'vitest'
import { crc32, zip } from './zip'

/** Reads a STORE-only archive back through its central directory. */
function unzip(a: Uint8Array): Record<string, Uint8Array> {
  const v = new DataView(a.buffer, a.byteOffset, a.byteLength)
  const end = a.length - 22
  expect(v.getUint32(end, true)).toBe(0x06054b50)
  const count = v.getUint16(end + 10, true)
  let p = v.getUint32(end + 16, true)
  const out: Record<string, Uint8Array> = {}
  for (let k = 0; k < count; k++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50)
    const crc = v.getUint32(p + 16, true)
    const size = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true)
    const local = v.getUint32(p + 42, true)
    const name = new TextDecoder().decode(a.subarray(p + 46, p + 46 + nameLen))
    expect(v.getUint32(local, true)).toBe(0x04034b50)
    const start = local + 30 + v.getUint16(local + 26, true)
    const data = a.subarray(start, start + size)
    expect(crc32(data)).toBe(crc)
    out[name] = data
    p += 46 + nameLen
  }
  return out
}

describe('zip writer', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
  it('round-trips entries through the central directory', () => {
    const stl = new Uint8Array(4096).map((_, i) => i % 251)
    const json = new TextEncoder().encode('{"ok":true}')
    const files = unzip(zip([{ name: 'crown.stl', data: stl }, { name: 'crown.design.json', data: json }]))
    expect(Object.keys(files)).toEqual(['crown.stl', 'crown.design.json'])
    expect(Array.from(files['crown.stl'])).toEqual(Array.from(stl))
    expect(new TextDecoder().decode(files['crown.design.json'])).toBe('{"ok":true}')
  })
})
