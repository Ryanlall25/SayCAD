// Dev: renders one .eoff from /dev/eoff/<name> with labelled local axes.
// ?f=<file>&v=top|front|side   (top: looking down −z; front: looking along +y; side: along −x)
import * as THREE from 'three'
import { parseEoff } from '../src/crown/eoff'
const q = new URLSearchParams(location.search)
const buf = await (await fetch(`/dev/eoff/${q.get('f')}`)).arrayBuffer()
const g = parseEoff(buf)
const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
r.setSize(500, 500)
document.body.appendChild(r.domElement)
const s = new THREE.Scene()
s.background = new THREE.Color(0x222222)
s.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5))
const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200)
const v = q.get('v') ?? 'top'
if (v === 'top') { cam.position.set(0, 0, 60); cam.up.set(0, 1, 0) }
if (v === 'front') { cam.position.set(0, -60, 0); cam.up.set(0, 0, 1) }
if (v === 'side') { cam.position.set(60, 0, 0); cam.up.set(0, 0, 1) }
cam.lookAt(0, 0, 0)
const light = new THREE.DirectionalLight(0xffffff, 2); light.position.copy(cam.position); s.add(light)
s.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xe8c547, roughness: 0.5, side: THREE.DoubleSide })))
s.add(new THREE.AxesHelper(9)) // x red, y green, z blue
r.render(s, cam)
document.title = 'ready'
