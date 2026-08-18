// Hydrostatics from REAL geometry — the buoyancy/stability critic.
// Volume + centroid via divergence theorem over the manifold's triangles;
// equilibrium waterline by bisection; righting margin = CoB above CoM.
// Convention: +Y is UP; water surface is the plane y = w.

export function volumeCentroid(manifold) {
  const mesh = manifold.getMesh()
  const P = mesh.vertProperties
  const np = mesh.numProp
  let V = 0
  const C = [0, 0, 0]
  const tri = mesh.triVerts.length / 3
  for (let t = 0; t < tri; t++) {
    const a = mesh.triVerts[3 * t] * np, b = mesh.triVerts[3 * t + 1] * np, c = mesh.triVerts[3 * t + 2] * np
    const ax = P[a], ay = P[a + 1], az = P[a + 2]
    const bx = P[b], by = P[b + 1], bz = P[b + 2]
    const cx = P[c], cy = P[c + 1], cz = P[c + 2]
    const v = (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
    V += v
    C[0] += ((ax + bx + cx) / 4) * v
    C[1] += ((ay + by + cy) / 4) * v
    C[2] += ((az + bz + cz) / 4) * v
  }
  return { volume: V, centroid: V !== 0 ? C.map((x) => x / V) : [0, 0, 0] }
}

/** Volume+centroid of the DISPLACED water: the part's exterior envelope below
 *  the waterline. Pass the WATERTIGHT OUTER envelope (not the shell) — a
 *  sealed fish displaces its full outer form. */
export function submerged(envelope, waterY) {
  const below = envelope.trimByPlane([0, -1, 0], -waterY)
  return volumeCentroid(below)
}

/** Find the equilibrium waterline for a floating body.
 *  envelope: outer watertight form (mm). massG: total mass in grams.
 *  Water density 0.001 g/mm3. Returns {waterY, dispVolume, cob} or null if it sinks. */
export function equilibriumWaterline(envelope, massG, { rhoWater = 0.001 } = {}) {
  const bb = envelope.boundingBox()
  const yMin = bb.min[1], yMax = bb.max[1]
  const total = volumeCentroid(envelope).volume
  if (massG >= total * rhoWater) return null // denser than its displacement — sinks
  let lo = yMin, hi = yMax
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    const v = submerged(envelope, mid).volume
    if (v * rhoWater < massG) lo = mid
    else hi = mid
  }
  const waterY = (lo + hi) / 2
  const s = submerged(envelope, waterY)
  return { waterY, dispVolume: s.volume, cob: s.centroid, submergedFraction: s.volume / total }
}

/** Compose the center of mass from weighted part centroids + point masses.
 *  items: [{manifold?, point?, massG}] — manifold items use their centroid. */
export function centerOfMass(items) {
  let m = 0
  const c = [0, 0, 0]
  for (const it of items) {
    const p = it.manifold ? volumeCentroid(it.manifold).centroid : it.point
    m += it.massG
    c[0] += p[0] * it.massG
    c[1] += p[1] * it.massG
    c[2] += p[2] * it.massG
  }
  return { massG: m, com: c.map((x) => x / m) }
}

/** The verdict: floats? at what height? self-righting margin (mm of CoB above CoM)? */
export function stabilityReport(envelope, massItems) {
  const { massG, com } = centerOfMass(massItems)
  const eq = equilibriumWaterline(envelope, massG)
  if (!eq) return { floats: false, massG }
  return {
    floats: true,
    massG: +massG.toFixed(1),
    waterY: +eq.waterY.toFixed(1),
    submergedFraction: +eq.submergedFraction.toFixed(3),
    com: com.map((x) => +x.toFixed(1)),
    cob: eq.cob.map((x) => +x.toFixed(1)),
    rightingMarginMm: +(eq.cob[1] - com[1]).toFixed(1), // positive = CoB above CoM = self-righting
  }
}
