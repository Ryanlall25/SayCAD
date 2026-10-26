// Dev: renders a case's prep arch coloured by clearance to the opposing arch
// (red contact < 0.3 mm, orange < 0.6, green 0.6–4 = prep-like, grey farther),
// looking along the occlusal direction findPrep would use.
// /dev/scan-view.html?case=laura&prep=JawLower&ant=JawUpper[&dir=x,y,z][&mark=x,y,z;…]
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { SurfaceIndex, pca3, type Vec3 } from '../src/crown/geom'
import { weld } from '../src/crown/slice'
const q = new URLSearchParams(location.search)
const load = async (n: string): Promise<THREE.BufferGeometry> => new STLLoader().parse(await (await fetch(`/dev/cases/${q.get('case')}/${n}.stl`)).arrayBuffer())
const prep = weld(await load(q.get('prep')!))
const antG = q.get('ant') ? weld(await load(q.get('ant')!)) : null
const ant = antG ? new SurfaceIndex(antG) : null
const pos = prep.getAttribute('position') as THREE.BufferAttribute
const colors = new Float32Array(pos.count * 3)
const c = new THREE.Color()
for (let i = 0; i < pos.count; i++) {
  const d = ant ? ant.closest([pos.getX(i), pos.getY(i), pos.getZ(i)], 8)?.distance ?? 99 : 99
  c.set(q.get('plain') ? 0xe8e2d4 : d < 0.3 ? 0xd83a2e : d < 0.6 ? 0xf09a2a : d <= 4 ? 0x2fae5a : 0xcfcfcf)
  colors.set([c.r, c.g, c.b], i * 3)
}
prep.setAttribute('color', new THREE.BufferAttribute(colors, 3))
prep.computeVertexNormals()
prep.computeBoundingSphere()
const s = new THREE.Scene()
s.background = new THREE.Color(0xffffff)
s.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.6))
s.add(new THREE.Mesh(prep, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide })))
const sph = prep.boundingSphere!
let dir: Vec3
if (q.get('dir')) dir = q.get('dir')!.split(',').map(Number) as Vec3
else if (antG) {
  antG.computeBoundingSphere()
  const a = antG.boundingSphere!.center
  dir = [a.x - sph.center.x, a.y - sph.center.y, a.z - sph.center.z]
} else dir = [0, 1, 0]
const D = new THREE.Vector3(...dir).normalize()
const zoom = Number(q.get('zoom') ?? 1)
const cam = new THREE.OrthographicCamera(-sph.radius / zoom, sph.radius / zoom, sph.radius / zoom, -sph.radius / zoom, 0.1, sph.radius * 6)
cam.up.set(Math.abs(D.z) < 0.9 ? 0 : 1, 0, Math.abs(D.z) < 0.9 ? 1 : 0)
cam.position.copy(sph.center).addScaledVector(D, sph.radius * 3)
cam.lookAt(sph.center)
cam.updateMatrixWorld()
// fx,fy: a point of the full (zoom 1) view, 0..1 from the top-left, to centre on.
const look = q.get('at') ? new THREE.Vector3(...q.get('at')!.split(',').map(Number)) : sph.center.clone()
if (q.get('f') && !q.get('at')) {
  const [fx, fy] = q.get('f')!.split(',').map(Number)
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0)
  const upv = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1)
  look.addScaledVector(right, (fx - 0.5) * 2 * sph.radius).addScaledVector(upv, (0.5 - fy) * 2 * sph.radius)
}
cam.position.copy(look).addScaledVector(D, sph.radius * 3)
cam.lookAt(look)
const light = new THREE.DirectionalLight(0xffffff, 1.6)
light.position.copy(cam.position)
s.add(light)
for (const m of (q.get('mark') ?? '').split(';').filter(Boolean)) {
  const p = m.split(',').map(Number)
  const b = new THREE.Mesh(new THREE.SphereGeometry(Number(q.get('mr') ?? 1.2)), new THREE.MeshBasicMaterial({ color: 0x1060ff }))
  b.position.set(p[0], p[1], p[2])
  s.add(b)
}
const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
r.setSize(800, 800)
document.body.appendChild(r.domElement)
r.render(s, cam)
;(window as unknown as { __info: unknown }).__info = { dir: D.toArray(), center: sph.center.toArray(), radius: sph.radius, look: look.toArray() }
document.title = 'ready'
