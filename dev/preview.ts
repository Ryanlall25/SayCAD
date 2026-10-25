/**
 * Dev harness: renders the synthetic case's auto-designed crown from fixed
 * views for visual review (driven by Playwright — see dev/render.mjs).
 * ?view=occlusal|buccal|mesial|section  &hide=scan
 */
import * as THREE from 'three'
import { autoDesign, prepareCase } from '../src/crown/pipeline'
import { syntheticMolarCase } from '../src/crown/synthetic'
import { add, scale } from '../src/crown/geom'

const q = new URLSearchParams(location.search)
const view = q.get('view') ?? 'buccal'
const c = syntheticMolarCase()
const r = autoDesign(prepareCase({ toothNumber: c.toothNumber, prep: c.prep, antagonist: c.antagonist }), { tap: c.tapPoint })

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setSize(900, 700)
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0d1f1b)
const cam = new THREE.PerspectiveCamera(30, 900 / 700, 0.1, 1000)
scene.add(new THREE.HemisphereLight(0xffffff, 0x334444, 1.6))
const key = new THREE.DirectionalLight(0xffffff, 2.2)
scene.add(key)

const f = r.frame
const o = add(f.origin, scale(f.occlusal, 3))
const dirs: Record<string, [number, number, number]> = {
  occlusal: add(scale(f.occlusal, 1), scale(f.buccal, 0.15)),
  buccal: add(scale(f.buccal, 1), scale(f.occlusal, 0.35)),
  mesial: add(scale(f.mesial, 1), scale(f.occlusal, 0.3)),
  lingual: add(scale(f.buccal, -1), scale(f.occlusal, 0.35))
}
const d = dirs[view] ?? dirs.buccal
const dist = view === 'occlusal' ? 70 : 60
cam.position.set(o[0] + d[0] * dist, o[1] + d[1] * dist, o[2] + d[2] * dist)
cam.up.set(...(view === 'occlusal' ? f.mesial : f.occlusal))
cam.lookAt(o[0], o[1], o[2])
key.position.copy(cam.position)

if (q.get('hide') !== 'scan') {
  scene.add(new THREE.Mesh(c.prep, new THREE.MeshStandardMaterial({ color: 0x8fa79f, roughness: 0.7, side: THREE.DoubleSide })))
  if (view !== 'occlusal') scene.add(new THREE.Mesh(c.antagonist, new THREE.MeshStandardMaterial({ color: 0xc8c8c8, metalness: 0.3, roughness: 0.4, side: THREE.DoubleSide, transparent: true, opacity: 0.35 })))
}
scene.add(new THREE.Mesh(r.crown, new THREE.MeshStandardMaterial({ color: 0xf0ead9, roughness: 0.45 })))
const line = new THREE.BufferGeometry().setFromPoints(r.margin.points.map((p) => new THREE.Vector3(...p)))
scene.add(new THREE.LineLoop(line, new THREE.LineBasicMaterial({ color: 0xff3355 })))
renderer.render(scene, cam)
;(window as unknown as { __report: unknown }).__report = r.report.results.map((x) => `${x.verdict} ${x.label} ${x.measured}`)
document.title = 'ready'
