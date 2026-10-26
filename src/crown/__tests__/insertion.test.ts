import { describe, expect, it } from 'vitest'
import { add, dot, geometryToLocal, normalize, scale, toLocal, type Vec3 } from '../geom'
import { insertionAxis } from '../insertion'
import { detectMargin } from '../margin'
import { marginRowAt, neighbourSurfaces, prepareCase, stumpVertices } from '../pipeline'
import { syntheticMolarCase } from '../synthetic'

describe('path of insertion and neighbours', () => {
  const c = syntheticMolarCase()
  const pc = prepareCase({ toothNumber: c.toothNumber, prep: c.prep, antagonist: c.antagonist })
  const m = detectMargin(pc.prepIndex, c.tapPoint)

  it('keeps an undercut-free axis where it is', () => {
    const r = insertionAxis(pc.prepWelded, m.points, m.axis.up)
    expect(dot(r.axis, c.axis)).toBeGreaterThan(Math.cos((5 * Math.PI) / 180))
    expect(r.blockoutMm3).toBeLessThan(0.5)
  })

  it('finds the draw when the starting axis is tipped 15°', () => {
    const tipped = normalize(add(c.axis, scale(c.mesial, Math.tan((15 * Math.PI) / 180))))
    const r = insertionAxis(pc.prepWelded, m.points, tipped)
    expect(dot(r.axis, c.axis)).toBeGreaterThan(dot(tipped, c.axis))
  })

  it('separates the stump from the neighbour teeth', () => {
    const frame = { origin: m.points.reduce((a, p) => add(a, scale(p, 1 / m.points.length)), [0, 0, 0] as Vec3), occlusal: c.axis, buccal: c.buccal, mesial: c.mesial }
    const local = geometryToLocal(frame, pc.prepWelded)
    const row = marginRowAt(m.points.map((p) => toLocal(frame, p)), 128)
    const stump = stumpVertices(local, row)
    const pos = local.getAttribute('position')
    let onStump = 0
    let onNeighbours = 0
    for (let v = 0; v < pos.count; v++) {
      if (!stump[v]) continue
      if (Math.hypot(pos.getX(v), pos.getZ(v)) < 4) onStump++
      if (Math.abs(pos.getX(v)) > 7) onNeighbours++
    }
    expect(onStump).toBeGreaterThan(100)
    expect(onNeighbours).toBe(0)
    const nb = neighbourSurfaces(local, row)
    expect(nb.mesial).not.toBeNull()
    expect(nb.distal).not.toBeNull()
  })
})
