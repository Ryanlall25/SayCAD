import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js'

/**
 * Shared viewer rig for every 3D surface in the app (Tools viewer, case
 * "View all in 3D", SayCAD editor): the physically-tuned light rig, the
 * exocad camera-fit math, the dual-mode camera (trackball/turntable), and the
 * full exocad navigation input layer. One implementation so the editor cannot
 * drift from the viewer.
 *
 * CAMERA MODEL — trackball by default. OrbitControls is a TURNTABLE camera:
 * it locks world-up and hard-stops at the poles, so a model can never be
 * tumbled through a full revolution or rolled. Real CAD (exocad, Blender)
 * uses trackball rotation: the model behaves like a ball in the hand — any
 * orientation reachable, roll included, no gimbal stops. TrackballControls
 * was chosen over ArcballControls because Arcball ships its own on-screen
 * gizmo + focus animations that fight TransformControls and this nav layer,
 * while Trackball is minimal and constraint-free. A turntable mode remains as
 * an escape hatch for horizon-locked viewing (session-persisted preference).
 *
 * Two Trackball gaps are filled manually here: Shift+drag pan (Orbit demotes
 * a ROTATE button to PAN on shift natively; Trackball needs the button map
 * swapped while Shift is held) and scroll zoom-to-cursor (implemented as a
 * capture-phase wheel handler that scales camera AND target toward the point
 * under the cursor at target depth, matching OrbitControls.zoomToCursor).
 */

export type CameraMode = 'trackball' | 'turntable'

/** Session-persisted camera mode preference (module scope = app lifetime). */
let preferredCameraMode: CameraMode = 'trackball'

export function getPreferredCameraMode(): CameraMode {
  return preferredCameraMode
}

/**
 * Headlight rig, not fixed world-space lights. With fixed lights the far side
 * of a scan is lit only by ambient — orbiting a real arch 180° rendered it as
 * a murky dark blob. exocad-style viewers light from the camera, so whatever
 * faces you is always lit. Intensities are ×π because three r155+ uses
 * physical lighting units: the Lambert BRDF divides irradiance by π, so
 * legacy-style values deliver only ~1/3 of their apparent brightness
 * (measured on a real 3Shape arch: [127,104,88] murky vs [194,152,130] ×π).
 */
export function addHeadlightRig(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
  scene.add(new THREE.AmbientLight(0xffffff, 0.7 * Math.PI))
  const headlight = new THREE.DirectionalLight(0xffffff, 0.85 * Math.PI)
  headlight.position.set(0.4, 0.7, 1)
  headlight.target.position.set(0, 0, -1)
  camera.add(headlight)
  camera.add(headlight.target)
  // A camera's children are ignored unless the camera itself is in the scene.
  scene.add(camera)
}

/** Distance at which a sphere of radius r exactly fills the vertical FOV. */
export function fitDistanceFor(camera: THREE.PerspectiveCamera, r: number): number {
  return Math.max(r, 0.001) / Math.sin((Math.PI * camera.fov) / 360)
}

/** Client coords → NDC for raycasting against a canvas. */
export function eventNDC(canvas: HTMLElement, clientX: number, clientY: number): THREE.Vector2 {
  const rect = canvas.getBoundingClientRect()
  return new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  )
}

export function isEditableTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable)
  )
}

export interface ViewerRigOptions {
  container: HTMLElement
  /** renderer.domElement — the element the camera controls attach to. */
  canvas: HTMLElement
  camera: THREE.PerspectiveCamera
  /** Nearest visible surface under the cursor (scans + design objects). */
  pickHit(clientX: number, clientY: number): THREE.Intersection | null
  /** Shift+middle-click action on a hit surface (viewer: per-object
   *  transparency toggle). Optional — omitted = no-op. */
  onShiftMiddlePick?(hit: THREE.Intersection): void
  /** World-space bounding sphere to frame on double-click of a hit. */
  sphereForFocus(hit: THREE.Intersection): THREE.Sphere | null
  /** World-space bounds of everything visible, for Numpad5/Ctrl+0 fit. */
  fitSphere(): THREE.Sphere | null
  /** Camera distance for Numpad preset views (typically scene fit × 1.1). */
  presetDistance(): number
  /** Called after the mode toggles (UI sync). */
  onModeChange?(mode: CameraMode): void
  /**
   * Bind Ctrl+1..8 / Ctrl+0 as aliases for the numpad presets. Default TRUE —
   * they exist for keyboards without a numpad, and the plain 3D viewer has no
   * other way to reach a preset on that hardware.
   *
   * SayCADEditor passes FALSE, because it binds its own number-row DENTAL
   * view snaps, and the two tables disagree on every digit they share: these
   * presets put 3 on the RIGHT view ([1,0,0]) while the dental snap table puts
   * 3 on the LEFT. Shipping both would mean Ctrl+3 and 3 producing opposite
   * views of the same arch with nothing on screen explaining why.
   *
   * Scoped rather than deleted on purpose: Viewer3D shares this rig and has NO
   * number-row snaps, so removing the aliases outright would leave numpad-less
   * keyboards there with no preset views at all.
   */
  ctrlDigitPresets?: boolean
}

export interface ViewerRig {
  readonly mode: CameraMode
  /** Orbit/tumble pivot of the ACTIVE controls (live reference). */
  readonly target: THREE.Vector3
  setMode(mode: CameraMode): void
  /** Gizmo handshake: TransformControls 'dragging-changed' toggles this so a
   *  gizmo drag never also rotates the camera. */
  setEnabled(enabled: boolean): void
  setClamps(min: number, max: number): void
  /** TrackballControls caches the canvas rect — call on every resize. */
  handleResize(): void
  /** Drive damping + the ~300ms view animation; once per frame. */
  update(): void
  animateViewTo(toPos: THREE.Vector3, toTarget: THREE.Vector3): void
  cancelAnim(): void
  dispose(): void
}

/** Directions are unit offsets from the target toward the camera. */
const PRESET_DIRECTIONS: Record<string, [number, number, number]> = {
  '1': [0, 0, 1], // front
  '2': [0, 0, -1], // back
  '3': [1, 0, 0], // right
  '4': [-1, 0, 0], // left
  '6': [0, -1, 0.02], // bottom (slight tilt keeps turntable mode off its pole)
  '7': [0, 1, 0.02], // top
  '8': [0, 0.7, 1] // three-quarter front-top
}

export function createViewerRig(opts: ViewerRigOptions): ViewerRig {
  const { container, canvas, camera } = opts
  // Default TRUE — omitting the option must not silently drop a binding.
  const ctrlDigitPresets = opts.ctrlDigitPresets !== false

  let mode: CameraMode = preferredCameraMode
  let clampMin = 0
  let clampMax = Infinity
  let controls: TrackballControls | OrbitControls = makeControls(mode)

  function makeControls(m: CameraMode): TrackballControls | OrbitControls {
    if (m === 'turntable') {
      const c = new OrbitControls(camera, canvas)
      c.enableDamping = true
      c.dampingFactor = 0.05
      c.rotateSpeed = 0.8
      c.panSpeed = 0.8
      c.zoomToCursor = true
      // Both buttons rotate (exocad web = left, DentalCAD = right); Orbit
      // natively demotes a ROTATE button to PAN while shift is held.
      c.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY, // never reached — middle intercepted below
        RIGHT: THREE.MOUSE.ROTATE
      }
      return c
    }
    const c = new TrackballControls(camera, canvas)
    // Tuned so a full canvas-width drag ≈ one full revolution (exocad feel).
    c.rotateSpeed = 4.0
    c.panSpeed = 0.6
    c.zoomSpeed = 1.2 // touch pinch only — wheel is our cursor-zoom below
    c.staticMoving = false // short CAD inertia, not a spinning-globe demo:
    c.dynamicDampingFactor = 0.2
    c.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY, // never reached — middle intercepted below
      RIGHT: THREE.MOUSE.ROTATE
    }
    return c
  }

  function applyClamps(): void {
    controls.minDistance = clampMin
    controls.maxDistance = clampMax
  }

  function setMode(next: CameraMode): void {
    if (next === mode) return
    const target = controls.target.clone()
    controls.dispose()
    mode = next
    preferredCameraMode = next
    // Turntable assumes world-up; entering it from an arbitrary trackball
    // roll would corrupt Orbit's spherical math.
    if (next === 'turntable') camera.up.set(0, 1, 0)
    controls = makeControls(next)
    controls.target.copy(target)
    applyClamps()
    controls.update()
    opts.onModeChange?.(mode)
  }

  // ---- Shift+drag pan for trackball mode ------------------------------
  // Orbit handles shift natively; Trackball reads mouseButtons at
  // pointerdown, so the capture-phase pointerdown handler below swaps the
  // map according to the event's own shiftKey bit — runs before Trackball's
  // canvas listener, works for real and synthetic input alike.
  function setTrackballShiftPan(panning: boolean): void {
    if (!(controls instanceof TrackballControls)) return
    const action = panning ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE
    controls.mouseButtons.LEFT = action
    controls.mouseButtons.RIGHT = action
  }

  // ---- View animation (double-click focus / preset views / fit) --------
  let viewAnim: {
    fromPos: THREE.Vector3
    toPos: THREE.Vector3
    fromTarget: THREE.Vector3
    toTarget: THREE.Vector3
    start: number
  } | null = null

  function animateViewTo(toPos: THREE.Vector3, toTarget: THREE.Vector3): void {
    viewAnim = {
      fromPos: camera.position.clone(),
      toPos: toPos.clone(),
      fromTarget: controls.target.clone(),
      toTarget: toTarget.clone(),
      start: performance.now()
    }
  }

  // ---- Zoom-to-cursor (both modes' wheel path) --------------------------
  // Capture-phase on the CONTAINER so it runs before TrackballControls'
  // canvas wheel listener. Turntable mode keeps OrbitControls' native
  // zoomToCursor (only the animation cancel applies there).
  function onWheelCapture(e: WheelEvent): void {
    viewAnim = null
    if (!(controls instanceof TrackballControls) || !controls.enabled) return
    e.preventDefault()
    e.stopPropagation()
    // Point under the cursor at target depth: intersect the cursor ray with
    // the view-perpendicular plane through the target, then scale camera AND
    // target toward/away from it. Same geometry as Orbit's zoomToCursor.
    const ndc = eventNDC(canvas, e.clientX, e.clientY)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, camera)
    const viewDir = camera.getWorldDirection(new THREE.Vector3())
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir, controls.target)
    const cursorPoint = new THREE.Vector3()
    if (!ray.ray.intersectPlane(plane, cursorPoint)) return
    let k = Math.exp(e.deltaY * 0.0012) // one wheel notch ≈ 12% zoom
    // Respect the distance clamps: scale k so the new eye distance stays in
    // range (distance scales linearly with k because target moves too).
    const dist = camera.position.distanceTo(controls.target)
    const nextDist = dist * k
    if (nextDist < clampMin) k = clampMin / dist
    if (nextDist > clampMax) k = clampMax / dist
    // Compute BOTH new vectors before writing either — .copy() mutates in
    // place, and reading camera.position after mutating it collapses the
    // camera onto the cursor point (caught live by the acceptance battery).
    const newPos = cursorPoint
      .clone()
      .add(camera.position.clone().sub(cursorPoint).multiplyScalar(k))
    const newTarget = cursorPoint
      .clone()
      .add(controls.target.clone().sub(cursorPoint).multiplyScalar(k))
    camera.position.copy(newPos)
    controls.target.copy(newTarget)
  }
  container.addEventListener('wheel', onWheelCapture, { capture: true, passive: false })

  // ---- Mode-generic step rotation (PageUp/PageDown + 3-finger touch) ----
  // Trackball has no _rotateLeft internals; rotate the eye offset about the
  // camera's own up axis (azimuth) / right axis (elevation) so it works at
  // ANY orientation, including rolled or upside down.
  function rotateView(azimuth: number, elevation: number): void {
    const offset = camera.position.clone().sub(controls.target)
    const up = mode === 'turntable' ? new THREE.Vector3(0, 1, 0) : camera.up.clone().normalize()
    offset.applyAxisAngle(up, azimuth)
    if (elevation !== 0) {
      const right = new THREE.Vector3().crossVectors(up, offset).normalize()
      offset.applyAxisAngle(right, elevation)
      if (mode === 'trackball') camera.up.applyAxisAngle(right, elevation)
    }
    camera.position.copy(controls.target).add(offset)
  }

  function recenterPivot(clientX: number, clientY: number): void {
    const hit = opts.pickHit(clientX, clientY)
    // Miss = no-op; the camera must never jump on a stray middle-click.
    if (hit) controls.target.copy(hit.point)
  }

  function focusOnObject(clientX: number, clientY: number): void {
    const hit = opts.pickHit(clientX, clientY)
    if (!hit) return
    const sphere = opts.sphereForFocus(hit)
    if (!sphere) return
    // Approach along the current view direction — focus shouldn't reorient.
    const dir = camera.position.clone().sub(controls.target).normalize()
    animateViewTo(
      sphere.center.clone().add(dir.multiplyScalar(fitDistanceFor(camera, sphere.radius) * 1.1)),
      sphere.center
    )
  }

  let middleDown: { x: number; y: number; t: number } | null = null
  function onCapturePointerDown(e: PointerEvent): void {
    viewAnim = null // manual input takes over immediately
    // Clicking the viewer arms the keyboard shortcuts (hover also works).
    container.focus({ preventScroll: true })
    if (e.button === 0 || e.button === 2) setTrackballShiftPan(e.shiftKey)
    if (e.button === 1) {
      // Middle button is nav's alone (re-pivot / shift action): block the
      // controls' middle-dolly and the OS autoscroll cursor.
      e.stopPropagation()
      e.preventDefault()
      middleDown = { x: e.clientX, y: e.clientY, t: performance.now() }
    }
  }
  function onCapturePointerUp(e: PointerEvent): void {
    if (e.button !== 1) return
    e.stopPropagation()
    if (middleDown) {
      const dist = Math.hypot(e.clientX - middleDown.x, e.clientY - middleDown.y)
      const elapsed = performance.now() - middleDown.t
      if (dist < 6 && elapsed < 500) {
        if (e.shiftKey) {
          const hit = opts.pickHit(e.clientX, e.clientY)
          if (hit) opts.onShiftMiddlePick?.(hit)
        } else {
          recenterPivot(e.clientX, e.clientY)
        }
      }
    }
    middleDown = null
  }
  function onDoubleClick(e: MouseEvent): void {
    focusOnObject(e.clientX, e.clientY)
  }
  function onContextMenu(e: MouseEvent): void {
    e.preventDefault() // right button rotates; the menu would swallow the drag
  }
  container.addEventListener('pointerdown', onCapturePointerDown, { capture: true })
  container.addEventListener('pointerup', onCapturePointerUp, { capture: true })
  container.addEventListener('pointercancel', onCapturePointerUp, { capture: true })
  container.addEventListener('dblclick', onDoubleClick)
  container.addEventListener('contextmenu', onContextMenu)

  function goToPreset(digit: string): void {
    const d = PRESET_DIRECTIONS[digit]
    if (!d) return
    const dir = new THREE.Vector3(d[0], d[1], d[2]).normalize()
    const target = controls.target.clone()
    // Presets are canonical world orientations — clear any trackball roll.
    camera.up.set(0, 1, 0)
    animateViewTo(target.clone().add(dir.multiplyScalar(opts.presetDistance())), target)
  }
  function fitSceneView(): void {
    const sphere = opts.fitSphere()
    if (!sphere) return
    const dir = camera.position.clone().sub(controls.target).normalize()
    animateViewTo(
      sphere.center.clone().add(dir.multiplyScalar(fitDistanceFor(camera, sphere.radius) * 1.1)),
      sphere.center
    )
  }
  function onKeyDown(e: KeyboardEvent): void {
    // Never hijack typing, and stay inert unless the pointer is over the
    // viewer or it was focused by a click on the canvas.
    if (isEditableTarget(e.target)) return
    if (!container.matches(':hover') && document.activeElement !== container) return
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault()
      viewAnim = null
      // ~15° azimuth per press.
      rotateView(((e.key === 'PageUp' ? 1 : -1) * Math.PI) / 12, 0)
      return
    }
    // Numpad 1–8 presets, Numpad 5 fit — plus Ctrl+1..8 / Ctrl+0 for
    // keyboards without a numpad, UNLESS the host supplies its own number-row
    // view snaps (see `ctrlDigitPresets` for why that opt-out exists).
    let digit: string | null = null
    if (!e.ctrlKey && e.code.startsWith('Numpad')) digit = e.code.slice('Numpad'.length)
    else if (ctrlDigitPresets && e.ctrlKey && /^Digit[0-8]$/.test(e.code))
      digit = e.code.slice('Digit'.length)
    if (digit === null || !/^[0-8]$/.test(digit)) return
    e.preventDefault()
    if (digit === '5' || digit === '0') fitSceneView()
    else goToPreset(digit)
  }
  window.addEventListener('keydown', onKeyDown)

  // ---- 3-finger touch rotate -------------------------------------------
  // Native controls handle 1-finger rotate + 2-finger pinch/pan; at 3+
  // touches the active controls are disabled and the centroid drives a
  // mode-generic rotation.
  const activeTouches = new Map<number, { x: number; y: number }>()
  let touchRotateCentroid: { x: number; y: number } | null = null
  let touchDisabledControls = false
  function centroidOf(points: { x: number; y: number }[]): { x: number; y: number } {
    const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 })
    return { x: sum.x / points.length, y: sum.y / points.length }
  }
  function syncTouchState(): void {
    const three = activeTouches.size === 3
    touchRotateCentroid = three ? centroidOf([...activeTouches.values()]) : null
    if (three && !touchDisabledControls) {
      controls.enabled = false
      touchDisabledControls = true
    } else if (!three && touchDisabledControls) {
      controls.enabled = true
      touchDisabledControls = false
    }
  }
  function onTouchPointerDown(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return
    activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    syncTouchState()
  }
  function onTouchPointerMove(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || !activeTouches.has(e.pointerId)) return
    activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (activeTouches.size === 3 && touchRotateCentroid) {
      const next = centroidOf([...activeTouches.values()])
      const dx = next.x - touchRotateCentroid.x
      const dy = next.y - touchRotateCentroid.y
      touchRotateCentroid = next
      const height = container.clientHeight || 1
      rotateView((2 * Math.PI * dx * 0.8) / height, (2 * Math.PI * dy * 0.8) / height)
    }
  }
  function onTouchPointerUp(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return
    activeTouches.delete(e.pointerId)
    syncTouchState()
  }
  container.addEventListener('pointerdown', onTouchPointerDown)
  container.addEventListener('pointermove', onTouchPointerMove)
  container.addEventListener('pointerup', onTouchPointerUp)
  container.addEventListener('pointercancel', onTouchPointerUp)
  container.style.touchAction = 'none'

  applyClamps()

  return {
    get mode(): CameraMode {
      return mode
    },
    get target(): THREE.Vector3 {
      return controls.target
    },
    setMode,
    setEnabled(enabled: boolean): void {
      controls.enabled = enabled
    },
    setClamps(min: number, max: number): void {
      clampMin = min
      clampMax = max
      applyClamps()
    },
    handleResize(): void {
      if (controls instanceof TrackballControls) controls.handleResize()
    },
    update(): void {
      if (viewAnim) {
        const t = Math.min((performance.now() - viewAnim.start) / 300, 1)
        const k = t * t * (3 - 2 * t) // smoothstep ease in-out
        camera.position.lerpVectors(viewAnim.fromPos, viewAnim.toPos, k)
        controls.target.lerpVectors(viewAnim.fromTarget, viewAnim.toTarget, k)
        if (t >= 1) viewAnim = null
      }
      controls.update()
    },
    animateViewTo,
    cancelAnim(): void {
      viewAnim = null
    },
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown)
      container.removeEventListener('wheel', onWheelCapture, { capture: true })
      container.removeEventListener('pointerdown', onCapturePointerDown, { capture: true })
      container.removeEventListener('pointerup', onCapturePointerUp, { capture: true })
      container.removeEventListener('pointercancel', onCapturePointerUp, { capture: true })
      container.removeEventListener('dblclick', onDoubleClick)
      container.removeEventListener('contextmenu', onContextMenu)
      container.removeEventListener('pointerdown', onTouchPointerDown)
      container.removeEventListener('pointermove', onTouchPointerMove)
      container.removeEventListener('pointerup', onTouchPointerUp)
      container.removeEventListener('pointercancel', onTouchPointerUp)
      controls.dispose()
    }
  }
}

/** The control mappings shown by the "?" overlay — single source of truth so
 *  the viewer and the SayCAD editor list identical controls. */
export const NAV_HELP_ROWS: ReadonlyArray<readonly [string, string]> = navHelpRows(true)

/**
 * Build the nav help rows for a host, so the panel states what that host has
 * actually bound. A host that turns off `ctrlDigitPresets` must not keep
 * advertising Ctrl+1–8 — a help panel naming a dead key is worse than no help
 * panel, because the user blames themselves rather than the app.
 */
export function navHelpRows(ctrlDigitPresets: boolean): ReadonlyArray<readonly [string, string]> {
  return [
    ['Tumble / rotate', 'Left / Right drag'],
    ['Pan', 'Shift + drag'],
    ['Zoom to cursor', 'Scroll'],
    ['Set pivot point', 'Middle-click'],
    ['Focus object', 'Double-click'],
    ['Toggle transparency', 'Shift + Middle-click'],
    ['Step rotate', 'PgUp / PgDn'],
    ['Preset views', ctrlDigitPresets ? 'Numpad 1–8 · Ctrl+1–8' : 'Numpad 1–8'],
    ['Fit all', ctrlDigitPresets ? 'Numpad 5 · Ctrl+0' : 'Numpad 5'],
    ['Grid: background / overlay / off', 'G']
  ]
}
