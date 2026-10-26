/**
 * Minimal ZIP reader for scan exports (iTero, Medit and exocad folders are
 * usually sent zipped). Reads the central directory, supports STORE and
 * DEFLATE (via the platform's DecompressionStream). No ZIP64, no encryption.
 */

export interface UnzippedEntry {
  name: string
  data: Uint8Array<ArrayBuffer>
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

async function inflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(c) {
      c.enqueue(data)
      c.close()
    }
  })
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    total += value.length
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Entries of a zip archive; `keep` filters by name before decompressing. */
export async function unzip(buffer: ArrayBuffer, keep: (name: string) => boolean = () => true): Promise<UnzippedEntry[]> {
  const v = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  // The end-of-central-directory record sits in the last 64 KiB + 22 bytes.
  let eocd = -1
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a zip file.')
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  if (p === 0xffffffff) throw new Error('This zip uses ZIP64, which is not supported — unzip it first.')
  const dec = new TextDecoder()
  const out: UnzippedEntry[] = []
  for (let k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== CENTRAL) throw new Error('Damaged zip file.')
    const flags = v.getUint16(p + 8, true)
    const method = v.getUint16(p + 10, true)
    const size = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    const local = v.getUint32(p + 42, true)
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/') || !keep(name)) continue
    if (flags & 1) throw new Error(`${name} is encrypted.`)
    if (v.getUint32(local, true) !== LOCAL) throw new Error('Damaged zip file.')
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    const raw = bytes.slice(start, start + size)
    if (method === 0) out.push({ name, data: raw })
    else if (method === 8) out.push({ name, data: await inflateRaw(raw) })
    else throw new Error(`${name} uses an unsupported compression method (${method}).`)
  }
  return out
}
