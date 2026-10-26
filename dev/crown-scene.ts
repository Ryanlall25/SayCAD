// Dev: a designed crown seated on the real prep arch with the opposing arch
// in occlusion, from several directions (local only — cases stay in dev/cases).
// /dev/crown-scene.html?case=laura&prep=JawUpper&opp=JawLower&crown=out/crown.stl&at=x,y,z&up=x,y,z&mesial=x,y,z[&r=12][&margin=x,y,z;…]
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
const q = new URLSearchParams(location.search)
const load = async (p: string, crop = 0): Promise<THREE.BufferGeometry> => {
  let g = new STLLoader().parse(await (await fetch(`/dev/cases/${q.get('case')}/${p}?t=${Date.now()}`)).arrayBuffer())
  if (crop) {
    // Keep only triangles near the crown: far scan flaps block the views.
    const pos = g.getAttribute('position')
    const keep: number[] = []
    for (let t = 0; t < pos.count; t += 3) {
      const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3 - at.x
      const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3 - at.y
      const cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3 - at.z
      if (cx * cx + cy * cy + cz * cz > crop * crop) continue
      for (let k = 0; k < 3; k++) keep.push(pos.getX(t + k), pos.getY(t + k), pos.getZ(t + k))
    }
    g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(keep), 3))
  }
  g.computeVertexNormals()
  return g
}
const v3 = (k: string, d: number[]): THREE.Vector3 => new THREE.Vector3(...(q.get(k)?.split(',').map(Number) ?? d))
const at = v3('at', [0, 0, 0])
const up = v3('up', [0, 0, 1]).normalize()
const mes = v3('mesial', [1, 0, 0])
mes.addScaledVector(up, -mes.dot(up)).normalize()
const buc = new THREE.Vector3().crossVectors(up, mes).normalize()
const R = Number(q.get('r') ?? 12)
const CROP = Number(q.get('crop') ?? R * 1.8)
const gum = new THREE.MeshPhysicalMaterial({ color: 0xb9b2a6, roughness: 0.7, side: THREE.DoubleSide })
const opp = new THREE.MeshPhysicalMaterial({ color: 0x9fa6a8, roughness: 0.7, side: THREE.DoubleSide, transparent: true, opacity: Number(q.get('oppAlpha') ?? 1) })
const zr = new THREE.MeshPhysicalMaterial({ color: 0xf6ecd6, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.25, sheen: 0.3, side: THREE.DoubleSide })
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x101414)
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.1))
const prepM = q.get('noprep') ? null : new THREE.Mesh(await load(`${q.get('prep')}.stl`, CROP), gum)
if (prepM) scene.add(prepM)
const oppM = q.get('opp') ? new THREE.Mesh(await load(`${q.get('opp')}.stl`, CROP), opp) : null
if (oppM) scene.add(oppM)
if (q.get('crown')) scene.add(new THREE.Mesh(await load(q.get('crown')!), zr))
for (const m of (q.get('margin') ?? '').split(';').filter(Boolean)) {
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.12), new THREE.MeshBasicMaterial({ color: 0x2f7dff }))
  b.position.set(...(m.split(',').map(Number) as [number, number, number]))
  scene.add(b)
}
// Views: name → (eye direction, show opposing).
const views: Array<[string, THREE.Vector3, boolean]> = q.get('views') === 'crown' ? [
  ['buccal · crown', buc.clone().addScaledVector(up, 0.1), false],
  ['lingual · crown', buc.clone().negate().addScaledVector(up, 0.1), false],
  ['mesial · crown', mes.clone(), false],
  ['distal · crown', mes.clone().negate(), false],
  ['occlusal · crown', up.clone(), false],
  ['buccal-occlusal · crown', buc.clone().addScaledVector(up, 1), false]
] : [
  ['buccal · in occlusion', buc.clone().addScaledVector(up, 0.15), true],
  ['lingual · in occlusion', buc.clone().negate().addScaledVector(up, 0.15), true],
  ['occlusal · opposing hidden', up.clone().addScaledVector(buc, 0.12), false],
  ['mesial · in occlusion', mes.clone().addScaledVector(buc, 0.35), true],
  ['buccal · opposing hidden', buc.clone().addScaledVector(up, 0.5), false],
  ['distal · in occlusion', mes.clone().negate().addScaledVector(buc, 0.35), true]
]
for (const [name, dir, showOpp] of q.get('only') ? [views[Number(q.get('only'))]] : views) {
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  r.setSize(400, 400)
  r.toneMapping = THREE.ACESFilmicToneMapping
  const cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.1, 500)
  dir.normalize()
  cam.position.copy(at).addScaledVector(dir, 120)
  cam.up.copy(Math.abs(dir.dot(up)) > 0.8 ? buc : up)
  cam.lookAt(at)
  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.copy(cam.position).addScaledVector(up, 60).addScaledVector(mes, 40)
  const fill = new THREE.DirectionalLight(0xbfd8ff, 0.6)
  fill.position.copy(at).addScaledVector(dir, 50).addScaledVector(mes, -60)
  scene.add(key, fill)
  if (oppM) oppM.visible = showOpp
  r.render(scene, cam)
  scene.remove(key, fill)
  const d = document.createElement('div')
  d.className = 'v'
  d.append(r.domElement)
  const s = document.createElement('span')
  s.textContent = name
  d.append(s)
  document.body.append(d)
}
document.title = 'ready'
