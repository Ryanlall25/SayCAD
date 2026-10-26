import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { plyBinary, readSih, SihError, writeSih } from './sih'
import { unzip } from './unzip'
import { zip } from './zip'

const tri = (colour: boolean): THREE.BufferGeometry => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0.5]), 3))
  if (colour) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0.5, 0.5]), 3))
  g.setIndex([0, 1, 2, 1, 3, 2])
  return g
}

describe('.sih case files', () => {
  it('round-trips scans (with colour), the case and the design', async () => {
    const bytes = await writeSih({
      case: { id: 'case01', tooth: 30, system: 'universal', material: 'zirconia-hs', shade: 'A2' },
      scans: [
        { role: 'prep', jaw: 'lower', geometry: tri(true) },
        { role: 'antagonist', jaw: 'upper', geometry: tri(false) }
      ],
      design: { margin: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], insertionAxis: [0, 0, 1], crown: tri(false), record: { checks: 9 } },
      extra: [{ name: 'rx.txt', data: new TextEncoder().encode('zirconia, A2') }]
    })
    const c = await readSih(bytes.buffer)
    expect(c.manifest.format).toBe('sih/1')
    expect(c.case).toMatchObject({ tooth: 30, shade: 'A2' })
    expect(c.scans.map((s) => [s.role, s.jaw])).toEqual([['prep', 'lower'], ['antagonist', 'upper']])
    const g = c.scans[0].geometry
    expect(g.getAttribute('position').count).toBe(4)
    expect(Array.from(g.index!.array)).toEqual([0, 1, 2, 1, 3, 2])
    expect(g.getAttribute('position').getZ(3)).toBeCloseTo(0.5)
    expect(g.getAttribute('color').getX(0)).toBeCloseTo(1)
    expect(c.scans[1].geometry.getAttribute('color')).toBeUndefined()
    expect(c.design?.margin).toHaveLength(3)
    expect(c.design?.crown?.getAttribute('position').count).toBe(6)
    expect(c.design?.record).toEqual({ checks: 9 })
    expect(new TextDecoder().decode(c.extra![0].data)).toBe('zirconia, A2')
  })

  it('keeps its parts as standard files: the PLY opens on its own', async () => {
    const ply = new TextDecoder().decode(plyBinary(tri(true)).slice(0, 200))
    expect(ply).toMatch(/^ply\nformat binary_little_endian 1.0/)
    expect(ply).toContain('property uchar red')
  })

  it('refuses a damaged or foreign file', async () => {
    const bytes = await writeSih({ case: { tooth: 3 }, scans: [{ role: 'prep', geometry: tri(false) }] })
    const entries = await unzip(bytes.buffer)
    const tampered = zip(entries.map((e) => (e.name.endsWith('.ply') ? { name: e.name, data: e.data.map((b, i) => (i === e.data.length - 1 ? b ^ 1 : b)) } : e)))
    await expect(readSih(tampered.buffer)).rejects.toThrow(/checksum/)
    await expect(readSih(zip([{ name: 'other.txt', data: new Uint8Array([1]) }]).buffer)).rejects.toBeInstanceOf(SihError)
    await expect(readSih(new Uint8Array([1, 2, 3]).buffer)).rejects.toBeInstanceOf(SihError)
  })
})

describe('material names from lab systems', () => {
  it('maps common names to material ids', async () => {
    const { materialFromText } = await import('../crown/materials')
    expect(materialFromText('Zirconia')).toBe('zirconia-hs')
    expect(materialFromText('Zirconia HT multilayer')).toBe('zirconia-ht')
    expect(materialFromText('IPS e.max CAD')).toBe('lithium-disilicate')
    expect(materialFromText('zirconia-hs')).toBe('zirconia-hs')
    expect(materialFromText('Titanium')).toBeNull()
  })
})
