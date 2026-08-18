// Render STL parts to PNG via headless Chromium + three.js — the delivery
// preview machinery. Usage: node render.mjs out.png part1.stl [part2.stl ...]
// Layout: parts arranged left-to-right ("exploded"); pass --assembled to
// stack them at their native coordinates instead.
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const assembled = args.includes('--assembled')
const zup = args.includes('--zup') // rotate so the fish's +Z (up) is screen-up
const waterArg = args.find((a) => a.startsWith('--water='))
const waterZ = waterArg ? parseFloat(waterArg.split('=')[1]) : null
const files = args.filter((a) => !a.startsWith('--'))
const [out, ...stls] = files

function parseSTL(buf) {
  const tri = buf.readUInt32LE(80)
  const pos = new Float32Array(tri * 9)
  let off = 84
  for (let t = 0; t < tri; t++) {
    off += 12 // skip normal; recompute in shader-less lighting via computeVertexNormals
    for (let v = 0; v < 9; v++) {
      pos[t * 9 + v] = buf.readFloatLE(off)
      off += 4
    }
    off += 2
  }
  return Array.from(pos)
}

const parts = stls.map((p) => ({ name: p.replace(/^.*\//, ''), pos: parseSTL(readFileSync(p)) }))

const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0d1f1b">
<canvas id="c" width="1600" height="900"></canvas>
<script type="module">
import * as THREE from '/node_modules/three/build/three.module.js'
window.PARTS = ${JSON.stringify(parts.map((p) => p.name))}
const data = ${JSON.stringify(parts.map((p) => p.pos))}
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0d1f1b)
const cam = new THREE.PerspectiveCamera(40, 1600/900, 1, 5000)
const renderer = new THREE.WebGLRenderer({canvas: document.getElementById('c'), antialias: true})
renderer.setSize(1600, 900)
scene.add(new THREE.AmbientLight(0xffffff, .45))
const key = new THREE.DirectionalLight(0xfff2dd, 1.1); key.position.set(1,2,1.5); scene.add(key)
const rim = new THREE.DirectionalLight(0x88ccff, .5); rim.position.set(-2,.5,-1); scene.add(rim)
const group = new THREE.Group()
let cursor = 0
const all = new THREE.Box3()
data.forEach((pos, i) => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({color: 0xf0ead9, roughness: .45, metalness: .05}))
  g.computeBoundingBox()
  const bb = g.boundingBox
  if (${assembled}) { group.add(mesh) } else {
    mesh.position.x = cursor - bb.min.x
    cursor += (bb.max.x - bb.min.x) + 14
    group.add(mesh)
  }
  all.union(bb.clone().translate(mesh.position))
})
scene.add(group)
const ctr = all.getCenter(new THREE.Vector3()); const size = all.getSize(new THREE.Vector3())
const r = Math.max(size.x, size.y, size.z)
group.position.sub(ctr)
if (${zup}) group.rotateX(-Math.PI / 2) // fish +Z → screen up
cam.position.set(r*0.9, r*0.65, r*1.15); cam.lookAt(0,0,0)
if (${waterZ !== null}) {
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(r*3.2, r*3.2),
    new THREE.MeshStandardMaterial({color: 0x2277cc, transparent: true, opacity: 0.4, roughness: .2, side: THREE.DoubleSide}))
  water.rotateX(-Math.PI / 2)
  // group center was subtracted; in zup mode fish z maps to scene y
  water.position.y = ${waterZ ?? 0} - (${zup} ? ctr.z : ctr.y)
  scene.add(water)
} else {
  const grid = new THREE.GridHelper(r*2.2, 22, 0x2a5443, 0x1c3a33)
  grid.position.y = -size.y/2 - 4
  scene.add(grid)
}
renderer.render(scene, cam)
window.DONE = true
</script>`

const tmp = new URL('./_render.html', import.meta.url).pathname
writeFileSync(tmp, html)
import { spawn } from 'node:child_process'
const srv = spawn('python3', ['-m', 'http.server', '8917', '--bind', '127.0.0.1'], { cwd: new URL('./', import.meta.url).pathname, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1200))
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await page.goto('http://127.0.0.1:8917/_render.html')
await page.waitForFunction('window.DONE === true', { timeout: 30000 })
const el = await page.$('#c')
await el.screenshot({ path: out })
await browser.close()
srv.kill()
console.log('rendered', stls.length, 'part(s) →', out)
