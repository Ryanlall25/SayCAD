import { describe, expect, it } from 'vitest'
import { unzip } from './unzip'
import { zip, crc32 } from './zip'

/** A one-entry DEFLATE zip, built by hand the way scanners write them. */
async function deflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const s = new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (c) => { c.enqueue(data); c.close() } })
  const r = s.pipeThrough(new CompressionStream('deflate-raw')).getReader()
  const parts: number[] = []
  for (;;) {
    const { done, value } = await r.read()
    if (done) break
    parts.push(...value)
  }
  return new Uint8Array(parts)
}

async function deflatedZip(name: string, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const enc = new TextEncoder().encode(name)
  const comp = await deflateRaw(data)
  const local = new Uint8Array(30 + enc.length)
  const lv = new DataView(local.buffer)
  lv.setUint32(0, 0x04034b50, true)
  lv.setUint16(8, 8, true)
  lv.setUint32(14, crc32(data), true)
  lv.setUint32(18, comp.length, true)
  lv.setUint32(22, data.length, true)
  lv.setUint16(26, enc.length, true)
  local.set(enc, 30)
  const central = new Uint8Array(46 + enc.length)
  const cv = new DataView(central.buffer)
  cv.setUint32(0, 0x02014b50, true)
  cv.setUint16(10, 8, true)
  cv.setUint32(16, crc32(data), true)
  cv.setUint32(20, comp.length, true)
  cv.setUint32(24, data.length, true)
  cv.setUint16(28, enc.length, true)
  cv.setUint32(42, 0, true)
  central.set(enc, 46)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, 1, true)
  ev.setUint16(10, 1, true)
  ev.setUint32(12, central.length, true)
  ev.setUint32(16, local.length + comp.length, true)
  const out = new Uint8Array(local.length + comp.length + central.length + end.length)
  out.set(local, 0)
  out.set(comp, local.length)
  out.set(central, local.length + comp.length)
  out.set(end, local.length + comp.length + central.length)
  return out.buffer
}

describe('unzip', () => {
  it('reads stored entries (round trip with our writer) and filters by name', async () => {
    const a = new TextEncoder().encode('solid a')
    const b = new Uint8Array([1, 2, 3])
    const z = zip([{ name: 'case/lowerjaw.stl', data: a }, { name: 'case/notes.txt', data: b }])
    const all = await unzip(z.buffer)
    expect(all.map((e) => e.name)).toEqual(['case/lowerjaw.stl', 'case/notes.txt'])
    expect(new TextDecoder().decode(all[0].data)).toBe('solid a')
    const stl = await unzip(z.buffer, (n) => n.endsWith('.stl'))
    expect(stl.length).toBe(1)
  })

  it('inflates DEFLATE entries', async () => {
    const data = new Uint8Array(20000).map((_, i) => i % 7)
    const [e] = await unzip(await deflatedZip('upperjaw.stl', data))
    expect(e.name).toBe('upperjaw.stl')
    expect(e.data).toEqual(data)
  })

  it('rejects non-zips', async () => {
    await expect(unzip(new Uint8Array(100).buffer)).rejects.toThrow('Not a zip')
  })
})
