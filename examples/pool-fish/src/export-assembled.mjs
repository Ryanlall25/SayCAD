// export-assembled.mjs — render-only STLs of the fish AS ASSEMBLED:
// skirt-less pods, tail on its hinge, fins seated, ballast plugs in the belly
// ports, pin + retainer cap. Written to ../parts/assembled/.
import { boot, M, writeSTL } from '../lib.mjs'
import { buildPods } from './pods.mjs'
import { tailAssembly, hingePin, retainerCap, HINGE } from './tailparts.mjs'
import { ballastPlug, finDorsal, finPectoral, P7 } from './smallparts.mjs'
import { mkdirSync } from 'node:fs'

await boot()
const dir = new URL('../parts/assembled/', import.meta.url).pathname
mkdirSync(dir, { recursive: true })

const put = (m, name) => {
  const r = writeSTL(m, dir + name + '.stl', `saycad fish assembled ${name}`)
  console.log(name, r.triangles, 'tris')
  m.delete()
}

const { p1, p2 } = buildPods({ skirts: false })
put(p1.manifold, 'p1')
put(p2.manifold, 'p2')

const tail = tailAssembly()
put(tail.manifold, 'p3-tail')

// pin: printed head-down (head z 0..2, shank up); assembled head-UP with the
// head top at z 24 → flip 180° about X then translate
const pin = hingePin()
put(pin.manifold.rotate([180, 0, 0]).translate([HINGE.axisGlobalX, 0, 24]), 'p4-pin')
pin.manifold.delete()
// cap: printed bore-down (bore z 0..4); assembled bore-UP catching the pin tip
const cap = retainerCap()
put(cap.manifold.rotate([180, 0, 0]).translate([HINGE.axisGlobalX, 0, -24]), 'p4a-cap')
cap.manifold.delete()

// ballast plugs: knob at z 0..6, thread up — shoulder lands on each boss face
const plugF = ballastPlug()
put(plugF.manifold.translate([-50, 0, -34.2 - 6]), 'p5-plug-fwd')
plugF.manifold.delete()
const plugA = ballastPlug()
put(plugA.manifold.translate([10, 0, -35.2 - 6]), 'p5-plug-aft')
plugA.manifold.delete()

// dorsal fin: baseline along +X, tang at local x = 0.42·L pointing −z.
// Socket at (−60, 0), mouth z 31.6 → tang axis lands on the socket axis.
const dorsal = finDorsal()
put(dorsal.manifold.translate([-60 - 0.42 * P7.dorsal.L, 0, 31.6]), 'p7-dorsal')
dorsal.manifold.delete()
// pectorals: rotate −115°·sy about X — the tang (local −z) maps to the
// socket's inward-up axis (0, −0.906·sy, +0.423) and the blade sweeps
// out-down (audit: +65° mounted them inside-out, tang aiming into the water)
for (const sy of [1, -1]) {
  const fin = finPectoral()
  const xT = 0.42 * P7.pectoral.L
  const placed = fin.manifold.translate([-xT, 0, 0]).rotate([-115 * sy, 0, 0])
    .translate([5, sy * 24.4, -16])
  put(placed, sy > 0 ? 'p7-pect-L' : 'p7-pect-R')
  fin.manifold.delete()
}
console.log('assembled set →', dir)
