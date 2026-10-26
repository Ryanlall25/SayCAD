import * as THREE from 'three'
import { addHeadlightRig, createViewerRig, eventNDC, fitDistanceFor, type ViewerRig } from '../core/viewerRig'
import { NEUTRAL_COLOR } from '../core/scanLoad'
import type { ToothFrame, Vec3 } from '../crown/geom'
import type { DesignData } from '../crown/protocol'
import type { CrownLayer, CrownView } from '../speak/crownParser'

/**
 * The Crown Studio 3D view: scans, crown, margin line, orientation arrows
 * and the sculpt marker, on the shared SayCAD viewer rig (one-finger
 * tumble, two-finger zoom/pan on a phone). Taps — short, still touches —
 * are reported with what they hit; drags belong to the camera.
 */

export type PickTarget = 'scan' | 'crown' | 'antagonist'

export interface Pick {
  target: PickTarget
  point: Vec3
  /** Crown vertex nearest the hit (crown picks only). */
  vertex?: number
}

const CROWN_COLOR = 0xf0ead9

/** Thickness → colour: red below minimum, amber within 0.3 mm of it, teal above. */
function thicknessColor(t: number, min: number, out: THREE.Color): THREE.Color {
  if (!Number.isFinite(t)) return out.setHex(CROWN_COLOR)
  if (t < min - 0.02) return out.setHex(0xd8344a)
  if (t < min + 0.3) return out.setHex(0xe8b13a)
  if (t < min + 0.8) return out.setHex(0x6cc3a5)
  return out.setHex(0x3f7fbf)
}

export class StudioViewport {
  readonly renderer: THREE.WebGLRenderer
  readonly camera: THREE.PerspectiveCamera
  readonly scene = new THREE.Scene()
  private readonly rig: ViewerRig
  private readonly mount: HTMLElement
  private readonly groups = {
    scan: new THREE.Group(),
    antagonist: new THREE.Group(),
    crown: new THREE.Group(),
    margin: new THREE.Group(),
    frame: new THREE.Group(),
    marker: new THREE.Group()
  }
  private crownMesh: THREE.Mesh | null = null
  private scanMesh: THREE.Mesh | null = null
  private antMesh: THREE.Mesh | null = null
  private design: DesignData | null = null
  private frame: ToothFrame | null = null
  private heatmap = false
  private minThickness = { axial: 0.5, occlusal: 0.7 }
  private raf = 0
  private readonly ro: ResizeObserver
  private readonly raycaster = new THREE.Raycaster()
  private tapHandler: ((p: Pick | null) => void) | null = null
  private downAt: { x: number; y: number; t: number } | null = null

  constructor(mount: HTMLElement) {
    this.mount = mount
    this.scene.background = new THREE.Color(0x0d1f1b)
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 2000)
    this.camera.position.set(0, 60, 90)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(this.renderer.domElement)
    addHeadlightRig(this.scene, this.camera)
    for (const g of Object.values(this.groups)) this.scene.add(g)
    this.groups.antagonist.visible = true

    const fitSphere = (): THREE.Sphere | null => this.focusSphere()
    this.rig = createViewerRig({
      container: mount,
      canvas: this.renderer.domElement,
      camera: this.camera,
      pickHit: (cx, cy) => this.rayHit(cx, cy)?.hit ?? null,
      sphereForFocus: () => this.focusSphere(),
      fitSphere,
      presetDistance: () => {
        const s = fitSphere()
        return s ? fitDistanceFor(this.camera, s.radius) * 1.1 : 120
      },
      ctrlDigitPresets: false
    })

    const resize = (): void => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return
      this.renderer.setSize(w, h)
      this.camera.aspect = w / h
      this.applyInsets()
      this.rig.handleResize()
    }
    resize()
    this.ro = new ResizeObserver(resize)
    this.ro.observe(mount)

    const el = this.renderer.domElement
    el.addEventListener('pointerdown', this.onDown)
    el.addEventListener('pointerup', this.onUp)

    const loop = (): void => {
      this.raf = requestAnimationFrame(loop)
      this.rig.update()
      this.renderer.render(this.scene, this.camera)
      this.placeOverlays()
    }
    loop()
  }

  private onDown = (e: PointerEvent): void => {
    if (!e.isPrimary) {
      this.downAt = null
      return
    }
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() }
  }

  private onUp = (e: PointerEvent): void => {
    const d = this.downAt
    this.downAt = null
    if (!d || !this.tapHandler) return
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 450) return
    this.tapHandler(this.pick(e.clientX, e.clientY))
  }

  private insets = { top: 0, bottom: 0 }

  /**
   * Keeps the model centred in the part of the screen chrome doesn't cover
   * (the nav bar above, the sheet below) by shifting the projection — the
   * camera itself doesn't move, so orbiting still feels centred.
   */
  setObscured(top: number, bottom: number): void {
    const changed = Math.abs(top - this.insets.top) > 4 || Math.abs(bottom - this.insets.bottom) > 4
    this.insets = { top, bottom }
    this.applyInsets()
    // The distance depends on the visible area, so re-frame the last view
    // once the chrome has stopped moving.
    if (changed && this.lastView) {
      window.clearTimeout(this.reframeTimer)
      this.reframeTimer = window.setTimeout(() => this.lastView && this.view(this.lastView, true), 120)
    }
  }

  private reframeTimer = 0

  private lastView: CrownView | null = null

  private applyInsets(): void {
    const w = this.mount.clientWidth
    const h = this.mount.clientHeight
    const shift = (this.insets.bottom - this.insets.top) / 2
    if (w && h && Math.abs(shift) > 1) this.camera.setViewOffset(w, h, 0, shift, w, h)
    else this.camera.clearViewOffset()
    this.camera.updateProjectionMatrix()
  }

  /** Neutral studio backdrop that follows the system appearance. */
  setAppearance(dark: boolean): void {
    this.scene.background = new THREE.Color(dark ? 0x0b1110 : 0xd9dde3)
  }

  onTap(handler: (p: Pick | null) => void): void {
    this.tapHandler = handler
  }

  private rayHit(cx: number, cy: number): { hit: THREE.Intersection; target: PickTarget } | null {
    this.raycaster.setFromCamera(eventNDC(this.renderer.domElement, cx, cy), this.camera)
    const candidates: Array<[THREE.Mesh | null, PickTarget, boolean]> = [
      [this.crownMesh, 'crown', this.groups.crown.visible],
      [this.scanMesh, 'scan', this.groups.scan.visible],
      [this.antMesh, 'antagonist', this.groups.antagonist.visible]
    ]
    // The antagonist is drawn see-through and usually sits between the camera
    // and the crown, so it only counts when nothing solid was hit.
    let best: { hit: THREE.Intersection; target: PickTarget } | null = null
    for (const [mesh, target, visible] of candidates) {
      if (!mesh || !visible) continue
      if (target === 'antagonist' && best) break
      const hit = this.raycaster.intersectObject(mesh, false)[0]
      if (hit && (!best || hit.distance < best.hit.distance)) best = { hit, target }
    }
    return best
  }

  pick(cx: number, cy: number): Pick | null {
    const r = this.rayHit(cx, cy)
    if (!r) return null
    const p: Pick = { target: r.target, point: [r.hit.point.x, r.hit.point.y, r.hit.point.z] }
    if (r.target === 'crown' && r.hit.face && this.crownMesh) {
      const pos = this.crownMesh.geometry.getAttribute('position') as THREE.BufferAttribute
      let best = r.hit.face.a
      let bd = Infinity
      for (const v of [r.hit.face.a, r.hit.face.b, r.hit.face.c]) {
        const d = Math.hypot(pos.getX(v) - r.hit.point.x, pos.getY(v) - r.hit.point.y, pos.getZ(v) - r.hit.point.z)
        if (d < bd) {
          bd = d
          best = v
        }
      }
      p.vertex = best
    }
    return p
  }

  private focusSphere(): THREE.Sphere | null {
    const target = this.crownMesh ?? this.scanMesh
    if (!target) return null
    target.geometry.computeBoundingSphere()
    const s = target.geometry.boundingSphere!.clone()
    if (target === this.scanMesh && this.frame) {
      s.center.set(...this.frame.origin)
      s.radius = 14
    }
    return s
  }

  private static clear(g: THREE.Group): void {
    for (const c of [...g.children]) {
      g.remove(c)
      c.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        const mat = m.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat?.dispose()
      })
    }
  }

  setScan(g: THREE.BufferGeometry | null): void {
    StudioViewport.clear(this.groups.scan)
    this.scanMesh = null
    if (!g) return
    if (!g.getAttribute('normal')) g.computeVertexNormals()
    this.scanMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: NEUTRAL_COLOR, roughness: 0.68, metalness: 0.04, side: THREE.DoubleSide }))
    this.groups.scan.add(this.scanMesh)
  }

  setAntagonist(g: THREE.BufferGeometry | null): void {
    StudioViewport.clear(this.groups.antagonist)
    this.antMesh = null
    if (!g) return
    if (!g.getAttribute('normal')) g.computeVertexNormals()
    this.antMesh = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ color: 0xc8c8c8, metalness: 0.45, roughness: 0.35, side: THREE.DoubleSide, transparent: true, opacity: 0.45, depthWrite: false })
    )
    this.groups.antagonist.add(this.antMesh)
  }

  setCrown(d: DesignData | null, minAxial = 0.5, minOcclusal = 0.7): void {
    this.design = d
    this.minThickness = { axial: minAxial, occlusal: minOcclusal }
    StudioViewport.clear(this.groups.crown)
    this.crownMesh = null
    if (!d) return
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(d.crown.positions, 3))
    if (d.crown.indices) g.setIndex(new THREE.BufferAttribute(d.crown.indices, 1))
    g.computeVertexNormals()
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(d.crown.positions.length), 3))
    this.crownMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.02 }))
    this.groups.crown.add(this.crownMesh)
    this.paintCrown()
  }

  private paintCrown(): void {
    if (!this.crownMesh || !this.design) return
    const colors = this.crownMesh.geometry.getAttribute('color') as THREE.BufferAttribute
    const c = new THREE.Color()
    const nOuter = this.design.nu * this.design.nv
    for (let v = 0; v < colors.count; v++) {
      if (!this.heatmap || v >= nOuter) c.setHex(CROWN_COLOR)
      else {
        const j = Math.floor(v / this.design.nu)
        const occlusal = j > this.design.nv * 0.6
        thicknessColor(this.design.thickness[v], occlusal ? this.minThickness.occlusal : this.minThickness.axial, c)
      }
      colors.setXYZ(v, c.r, c.g, c.b)
    }
    colors.needsUpdate = true
  }

  setHeatmap(on: boolean): void {
    this.heatmap = on
    this.paintCrown()
  }

  get heatmapOn(): boolean {
    return this.heatmap
  }

  setMargin(points: Vec3[] | null, confidence?: number[]): void {
    StudioViewport.clear(this.groups.margin)
    if (!points || points.length < 3) return
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), true)
    const segs = points.length * 2
    const tube = new THREE.TubeGeometry(curve, segs, 0.07, 6, true)
    const colors = new Float32Array(tube.getAttribute('position').count * 3)
    const ring = 7
    const c = new THREE.Color()
    for (let s = 0; s <= segs; s++) {
      const k = Math.floor((s / segs) * points.length) % points.length
      const conf = confidence ? confidence[k] ?? 1 : 1
      c.setHSL(0.33 * Math.min(1, Math.max(0, conf)), 0.85, 0.5)
      for (let r = 0; r < ring; r++) {
        const v = s * ring + r
        if (v * 3 + 2 < colors.length) colors.set([c.r, c.g, c.b], v * 3)
      }
    }
    tube.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    // On top of everything while the margin is being found/edited; depth-tested
    // once a crown covers it, so it reads as the crown's edge, not a decal.
    this.groups.margin.add(new THREE.Mesh(tube, new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: !this.crownMesh ? false : true })))
    this.groups.margin.renderOrder = 10
  }

  setFrame(f: ToothFrame | null): void {
    this.frame = f
    StudioViewport.clear(this.groups.frame)
    if (!f) return
    const base = new THREE.Vector3(...f.origin).addScaledVector(new THREE.Vector3(...f.occlusal), 9)
    const arrow = (dir: Vec3, color: number, label: string): void => {
      const a = new THREE.ArrowHelper(new THREE.Vector3(...dir), base, 5, color, 1.2, 0.8)
      this.groups.frame.add(a)
      const sprite = makeLabel(label, color)
      sprite.position.copy(base).addScaledVector(new THREE.Vector3(...dir), 6.4)
      this.groups.frame.add(sprite)
    }
    arrow(f.buccal, 0xe8b13a, 'B')
    arrow(f.mesial, 0x6cc3a5, 'M')
  }

  /** Orientation arrows (B/M) — useful while checking margin and axis only. */
  setFrameVisible(on: boolean): void {
    this.groups.frame.visible = on
  }

  setMarker(p: Vec3 | null, radiusMm = 1.5): void {
    StudioViewport.clear(this.groups.marker)
    if (!p) return
    const ring = new THREE.Mesh(new THREE.SphereGeometry(radiusMm, 24, 16), new THREE.MeshBasicMaterial({ color: 0xc9a24b, transparent: true, opacity: 0.35, depthWrite: false }))
    ring.position.set(...p)
    this.groups.marker.add(ring)
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), new THREE.MeshBasicMaterial({ color: 0xc9a24b }))
    dot.position.set(...p)
    this.groups.marker.add(dot)
  }

  setLayer(layer: CrownLayer, visible: boolean | 'toggle'): boolean {
    if (layer === 'heatmap') {
      const on = visible === 'toggle' ? !this.heatmap : visible
      this.setHeatmap(on)
      return on
    }
    const g = this.groups[layer === 'scan' ? 'scan' : layer]
    g.visible = visible === 'toggle' ? !g.visible : visible
    if (layer === 'margin') this.groups.frame.visible = g.visible
    return g.visible
  }

  layerVisible(layer: CrownLayer): boolean {
    if (layer === 'heatmap') return this.heatmap
    return this.groups[layer === 'scan' ? 'scan' : layer].visible
  }

  /** Camera to a named side of the tooth (needs a frame), or fit everything. */
  view(v: CrownView, animate = true, square = false): void {
    const f = this.frame
    const s = this.focusSphere()
    if (!s) return
    this.lastView = v
    // Frame for the part of the screen the chrome leaves visible.
    // Fit the narrower of the width (portrait phones) and the uncovered height.
    const w = this.mount.clientWidth || 1
    const h = this.mount.clientHeight || 1
    const visible = Math.max(160, h - this.insets.top - this.insets.bottom)
    const tanV = Math.tan((Math.PI * this.camera.fov) / 360)
    const half = Math.atan(tanV * (square ? 1 : Math.min(w / h, visible / h)))
    const dist = (Math.max(s.radius, 7) / Math.sin(half)) * 1.1
    let dir = new THREE.Vector3(0.0, 0.6, 1).normalize()
    let up = new THREE.Vector3(0, 1, 0)
    if (f) {
      const B = new THREE.Vector3(...f.buccal)
      const M = new THREE.Vector3(...f.mesial)
      const O = new THREE.Vector3(...f.occlusal)
      const map: Record<CrownView, THREE.Vector3> = {
        occlusal: O.clone().addScaledVector(B, 0.12),
        buccal: B.clone().addScaledVector(O, 0.45),
        lingual: B.clone().negate().addScaledVector(O, 0.45),
        mesial: M.clone().addScaledVector(O, 0.4),
        distal: M.clone().negate().addScaledVector(O, 0.4),
        fit: B.clone().addScaledVector(O, 0.9)
      }
      dir = map[v].normalize()
      up = v === 'occlusal' ? B.clone() : O.clone()
    }
    const to = s.center.clone().addScaledVector(dir, dist)
    this.camera.up.copy(up)
    if (animate) this.rig.animateViewTo(to, s.center.clone())
    else {
      this.camera.position.copy(to)
      this.camera.lookAt(s.center)
      this.rig.target.copy(s.center)
    }
  }

  /** PNG (base64, no prefix) of the scene from a named view — for AI review. */
  snapshot(v: CrownView, size = 768): string {
    const prevView = this.lastView
    const prev = { pos: this.camera.position.clone(), up: this.camera.up.clone(), target: this.rig.target.clone(), aspect: this.camera.aspect }
    const w = this.renderer.domElement.width
    const h = this.renderer.domElement.height
    this.rig.cancelAnim()
    this.camera.clearViewOffset()
    this.view(v, false, true)
    this.renderer.setSize(size, size, false)
    this.camera.aspect = 1
    this.camera.updateProjectionMatrix()
    this.renderer.render(this.scene, this.camera)
    const url = this.renderer.domElement.toDataURL('image/png')
    this.renderer.setSize(w / this.renderer.getPixelRatio(), h / this.renderer.getPixelRatio(), false)
    this.camera.aspect = prev.aspect
    this.applyInsets()
    this.camera.position.copy(prev.pos)
    this.camera.up.copy(prev.up)
    this.rig.target.copy(prev.target)
    this.lastView = prevView
    this.camera.lookAt(prev.target)
    return url.slice(url.indexOf(',') + 1)
  }

  /* ── HTML overlays pinned to 3D points (measurements, candidate pins) ── */
  private overlays: Array<{ el: HTMLElement; point: THREE.Vector3 }> = []

  private clearOverlays(kind: 'callout' | 'pin'): void {
    this.overlays = this.overlays.filter((o) => {
      if (o.el.dataset.kind !== kind) return true
      o.el.remove()
      return false
    })
  }

  /** Small measurement labels anchored to points on the model. */
  setCallouts(items: Array<{ point: Vec3; text: string }>): void {
    this.clearOverlays('callout')
    for (const it of items) {
      const el = document.createElement('div')
      el.className = 'st-callout'
      el.dataset.kind = 'callout'
      el.textContent = it.text
      this.mount.appendChild(el)
      this.overlays.push({ el, point: new THREE.Vector3(...it.point) })
    }
  }

  /** Numbered, tappable pins on the model (e.g. "which of these is the prep?"). */
  setPins(items: Array<{ point: Vec3; label: string; aria: string; onTap: () => void }>): void {
    this.clearOverlays('pin')
    for (const it of items) {
      const el = document.createElement('button')
      el.className = 'st-pin'
      el.dataset.kind = 'pin'
      el.textContent = it.label
      el.setAttribute('aria-label', it.aria)
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        it.onTap()
      })
      el.addEventListener('pointerdown', (e) => e.stopPropagation())
      this.mount.appendChild(el)
      this.overlays.push({ el, point: new THREE.Vector3(...it.point) })
    }
  }

  private readonly _v = new THREE.Vector3()
  private placeOverlays(): void {
    if (!this.overlays.length) return
    const w = this.mount.clientWidth
    const h = this.mount.clientHeight
    const placed: Array<[number, number]> = []
    for (const o of this.overlays) {
      const v = this._v.copy(o.point).project(this.camera)
      const visible = v.z > -1 && v.z < 1 && v.x > -1.05 && v.x < 1.05 && v.y > -1.05 && v.y < 1.05
      o.el.style.display = visible ? '' : 'none'
      if (!visible) continue
      let x = ((v.x + 1) / 2) * w
      let y = ((1 - v.y) / 2) * h
      if (o.el.dataset.kind === 'pin') {
        // Pins must stay tappable: push one off any pin already placed within 46 px.
        for (let pass = 0; pass < 3; pass++) {
          for (const [px, py] of placed) {
            const dx = x - px
            const dy = y - py
            const d = Math.hypot(dx, dy)
            if (d < 46) {
              const ux = d > 0.5 ? dx / d : 1
              const uy = d > 0.5 ? dy / d : 0
              x = px + ux * 46
              y = py + uy * 46
            }
          }
        }
        placed.push([x, y])
      }
      o.el.style.transform = `translate(${x}px, ${y}px)${o.el.dataset.kind === 'callout' ? ' translate(-50%, calc(-100% - 10px))' : ''}`
    }
  }

  dispose(): void {
    this.overlays.forEach((o) => o.el.remove())
    this.overlays = []
    cancelAnimationFrame(this.raf)
    window.clearTimeout(this.reframeTimer)
    this.ro.disconnect()
    this.renderer.domElement.removeEventListener('pointerdown', this.onDown)
    this.renderer.domElement.removeEventListener('pointerup', this.onUp)
    this.rig.dispose()
    for (const g of Object.values(this.groups)) StudioViewport.clear(g)
    this.renderer.dispose()
    this.mount.removeChild(this.renderer.domElement)
  }
}

function makeLabel(text: string, color: number): THREE.Sprite {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`
  ctx.beginPath()
  ctx.arc(32, 32, 28, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#0d1f1b'
  ctx.font = 'bold 34px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 32, 34)
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }))
  s.scale.set(2.2, 2.2, 1)
  return s
}
