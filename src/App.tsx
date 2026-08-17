/**
 * SayCAD standalone shell — the public, conversational face of the engine
 * extracted from the private dental design suite it grew out of. Everything scene-side (layers,
 * camera rig, grid, tooth library, undo, mesh IO) is the Suite's code
 * verbatim; this file adds the part the Suite doesn't have: a command bar
 * you can type or speak into, and the executor that turns parsed commands
 * into scene mutations with full undo.
 */
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { SayCADScene, type DesignObject } from './core/sceneModel'
import { UndoStack } from './core/undoStack'
import {
  addHeadlightRig,
  createViewerRig,
  eventNDC,
  fitDistanceFor,
  isEditableTarget,
  type ViewerRig
} from './core/viewerRig'
import { createReferenceGrid, loadGridMode, nextGridMode, saveGridMode, type ReferenceGrid } from './core/grid'
import { buildToothGeometry, TOOTH_LIBRARY_COLOR, TOOTH_MANIFEST, type ToothSpec } from './core/toothLibrary'
import { NEUTRAL_COLOR } from './core/scanLoad'
import { exportPLY, exportSTL, parseGeometry } from './core/meshConvert'
import { GRAMMAR_HELP, parse, type Command } from './speak/parser'
import { createDictation } from './speak/voice'

let nextId = 1
const newId = (): string => `obj-${nextId++}`

/** Seat a tooth at its natural spot on a simple elliptical arch (mm). */
function archPose(spec: ToothSpec): { x: number; z: number; rotY: number } {
  const HALF_ARCH_MM = 67 // cumulative mesiodistal widths, midline → third molar
  const a = spec.arch === 'upper' ? 29 : 26.5 // half-width across the molars
  const b = spec.arch === 'upper' ? 40 : 37 // front-back depth
  const idx =
    spec.number <= 8 ? 8 - spec.number : spec.number <= 16 ? spec.number - 9 : spec.number <= 24 ? 24 - spec.number : spec.number - 25
  const side = spec.number <= 8 || spec.number >= 25 ? 1 : -1
  // Widths ordered central incisor → third molar: teeth 9–16 (upper left) and
  // 25–32 (lower right) run in exactly that midline order in the manifest.
  const widths = (spec.arch === 'upper' ? TOOTH_MANIFEST.slice(8, 16) : TOOTH_MANIFEST.slice(24, 32)).map(
    (t) => t.defaultWidthMm
  )
  let s = 0
  for (let i = 0; i < idx; i++) s += widths[i] ?? 8
  s += (widths[idx] ?? 8) / 2
  const t = (s / HALF_ARCH_MM) * (Math.PI * 0.52)
  const x = a * Math.sin(t) * side
  const z = b * Math.cos(t) - b * 0.35
  const tanX = a * Math.cos(t) * side
  const tanZ = -b * Math.sin(t)
  return { x, z, rotY: Math.atan2(-tanZ, tanX) }
}

function toothMesh(spec: ToothSpec): THREE.Mesh {
  const geometry = buildToothGeometry(spec)
  const material = new THREE.MeshStandardMaterial({ color: TOOTH_LIBRARY_COLOR, roughness: 0.55, metalness: 0.05 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = spec.label
  return mesh
}

function primitiveMesh(shape: 'box' | 'cylinder' | 'sphere', dims: number[]): THREE.Mesh {
  let geometry: THREE.BufferGeometry
  let label: string
  if (shape === 'box') {
    const w = dims[0] || 20
    const d = dims[1] || w
    const h = dims[2] || Math.min(w, d)
    geometry = new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0)
    label = `box ${w}×${d}×${h}mm`
  } else if (shape === 'cylinder') {
    const r = dims[0] || 6
    const h = dims[1] || r * 2.5
    geometry = new THREE.CylinderGeometry(r, r, h, 48).translate(0, h / 2, 0)
    label = `cylinder r${r} h${h}mm`
  } else {
    const r = dims[0] || 8
    geometry = new THREE.SphereGeometry(r, 48, 32).translate(0, r, 0)
    label = `sphere r${r}mm`
  }
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: NEUTRAL_COLOR, roughness: 0.5, metalness: 0.08 })
  )
  mesh.name = label
  return mesh
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

interface Rig3D {
  scene: THREE.Scene
  cad: SayCADScene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  rig: ViewerRig
  grid: ReferenceGrid
  undo: UndoStack
}

export default function App(): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<Rig3D | null>(null)
  const selectedRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [status, setStatus] = useState('Say or type a command — try “build an upper arch”.')
  const [objectCount, setObjectCount] = useState(0)
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [input, setInput] = useState('')
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  /* ── three.js world ──────────────────────────────────────────────────── */
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const cad = new SayCADScene()
    const scene = cad.scene
    scene.background = new THREE.Color(0x0d1f1b)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000)
    camera.position.set(0, 70, 120)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)

    addHeadlightRig(scene, camera)
    const grid = createReferenceGrid(60, loadGridMode())
    cad.addReference(grid.object)

    const fitSphere = (): THREE.Sphere | null => {
      const box = cad.visibleBounds()
      if (!box) return null
      const sphere = new THREE.Sphere()
      box.getBoundingSphere(sphere)
      return sphere
    }

    const rig = createViewerRig({
      container: mount,
      canvas: renderer.domElement,
      camera,
      pickHit: (cx, cy) => cad.raycastAll(eventNDC(renderer.domElement, cx, cy), camera),
      sphereForFocus: (hit) => {
        const obj = hit.object as THREE.Mesh
        if (!obj.geometry.boundingSphere) obj.geometry.computeBoundingSphere()
        const s = obj.geometry.boundingSphere
        return s ? s.clone().applyMatrix4(obj.matrixWorld) : null
      },
      fitSphere,
      presetDistance: () => {
        const s = fitSphere()
        return s ? fitDistanceFor(camera, s.radius) * 1.1 : 170
      }
    })

    const undo = new UndoStack()
    const offUndo = undo.onChange(() => {
      setCanUndo(undo.canUndo)
      setCanRedo(undo.canRedo)
    })

    worldRef.current = { scene, cad, camera, renderer, rig, grid, undo }

    const resize = (): void => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      rig.handleResize()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    // Click-select (a click, not a drag — the rig owns drags).
    let downAt: [number, number] | null = null
    const onDown = (e: PointerEvent): void => {
      if (e.button === 0) downAt = [e.clientX, e.clientY]
    }
    const onUp = (e: PointerEvent): void => {
      if (!downAt || e.button !== 0) return
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1])
      downAt = null
      if (moved > 5) return
      const hit = cad.raycastDesign(eventNDC(renderer.domElement, e.clientX, e.clientY), camera)
      applySelection(hit?.object ?? null)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)

    const onKey = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target)) return
      const world = worldRef.current
      if (!world) return
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) world.undo.redo()
        else world.undo.undo()
        syncCount()
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        if (selectedRef.current) {
          e.preventDefault()
          runCommand({ kind: 'remove' })
        }
      }
    }
    window.addEventListener('keydown', onKey)

    let raf = 0
    const loop = (): void => {
      raf = requestAnimationFrame(loop)
      rig.update()
      renderer.render(scene, camera)
    }
    loop()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('keydown', onKey)
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      offUndo()
      rig.dispose()
      grid.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      worldRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── helpers over the live world ─────────────────────────────────────── */

  const syncCount = (): void => {
    const world = worldRef.current
    if (!world) return
    setObjectCount(world.cad.designObjects.length)
    if (selectedRef.current && !world.cad.getDesignObject(selectedRef.current)) applySelection(null)
  }

  function applySelection(obj: DesignObject | null): void {
    const world = worldRef.current
    if (!world) return
    for (const o of world.cad.designObjects) {
      const m = o.mesh.material as THREE.MeshStandardMaterial
      m.emissive.setHex(obj && o.id === obj.id ? 0x2a5443 : 0x000000)
      m.emissiveIntensity = 0.6
    }
    selectedRef.current = obj?.id ?? null
    setSelectedLabel(obj ? obj.mesh.name || obj.id : null)
  }

  function currentObject(): DesignObject | null {
    const world = worldRef.current
    if (!world) return null
    if (selectedRef.current) return world.cad.getDesignObject(selectedRef.current) ?? null
    return world.cad.designObjects[world.cad.designObjects.length - 1] ?? null
  }

  function fitView(): void {
    const world = worldRef.current
    if (!world) return
    const box = world.cad.visibleBounds()
    if (!box) return
    const sphere = new THREE.Sphere()
    box.getBoundingSphere(sphere)
    const dist = fitDistanceFor(world.camera, Math.max(sphere.radius, 5)) * 1.12
    const dir = world.camera.position.clone().sub(world.rig.target).normalize()
    if (!dir.lengthSq()) dir.set(0, 0.5, 1).normalize()
    world.rig.animateViewTo(sphere.center.clone().add(dir.multiplyScalar(dist)), sphere.center)
  }

  function addObject(obj: DesignObject, label: string, batch?: DesignObject[]): void {
    const world = worldRef.current
    if (!world) return
    const objs = batch ?? [obj]
    for (const o of objs) world.cad.addDesignObject(o)
    world.undo.push({
      label,
      undo: () => {
        for (const o of objs) world.cad.removeDesignObject(o.id)
        syncCount()
      },
      redo: () => {
        for (const o of objs) world.cad.addDesignObject(o)
        syncCount()
      }
    })
    applySelection(objs[objs.length - 1])
    syncCount()
    fitView()
  }

  function transformCurrent(label: string, mutate: (mesh: THREE.Mesh) => void): boolean {
    const world = worldRef.current
    const obj = currentObject()
    if (!world || !obj) return false
    const before = obj.mesh.matrix.clone()
    mutate(obj.mesh)
    obj.mesh.updateMatrix()
    const after = obj.mesh.matrix.clone()
    const apply = (m: THREE.Matrix4): void => {
      m.decompose(obj.mesh.position, obj.mesh.quaternion, obj.mesh.scale)
      obj.mesh.updateMatrix()
    }
    world.undo.push({ label, undo: () => apply(before), redo: () => apply(after) })
    return true
  }

  function exportAll(format: 'stl' | 'ply'): void {
    const world = worldRef.current
    if (!world || world.cad.designObjects.length === 0) {
      setStatus('Nothing to export yet — build something first.')
      return
    }
    const parts = world.cad.designObjects
      .filter((o) => o.mesh.visible)
      .map((o) => {
        const g = o.mesh.geometry.clone().toNonIndexed()
        const stripped = new THREE.BufferGeometry()
        stripped.setAttribute('position', g.getAttribute('position'))
        stripped.applyMatrix4(o.mesh.matrixWorld)
        stripped.computeVertexNormals()
        g.dispose()
        return stripped
      })
    const merged = mergeGeometries(parts, false)
    parts.forEach((p) => p.dispose())
    if (!merged) {
      setStatus('Export failed: geometries could not be merged.')
      return
    }
    if (format === 'stl') {
      download(exportSTL(merged), 'saycad-prototype.stl')
      setStatus(`Exported ${objectCount} object(s) → saycad-prototype.stl (printable).`)
    } else {
      void exportPLY(merged).then((blob) => {
        download(blob, 'saycad-prototype.ply')
        setStatus(`Exported ${objectCount} object(s) → saycad-prototype.ply.`)
      })
    }
    merged.dispose()
  }

  /* ── the executor ────────────────────────────────────────────────────── */

  function runCommand(cmd: Command): void {
    const world = worldRef.current
    if (!world) return
    switch (cmd.kind) {
      case 'addTooth': {
        const spec = TOOTH_MANIFEST[cmd.tooth - 1]
        const mesh = toothMesh(spec)
        const pose = archPose(spec)
        mesh.position.set(pose.x, 0, pose.z)
        mesh.rotation.y = pose.rotY
        addObject({ id: newId(), kind: 'tooth', toothNumber: spec.number, mesh }, `add ${spec.label}`)
        setStatus(`${spec.label} seated at its arch position.`)
        break
      }
      case 'addToothType': {
        const spec = TOOTH_MANIFEST.find((t) => t.type === cmd.toothType && t.arch === 'lower') ?? TOOTH_MANIFEST[29]
        runCommand({ kind: 'addTooth', tooth: spec.number })
        break
      }
      case 'arch': {
        const archesWanted = cmd.arch === 'both' ? (['upper', 'lower'] as const) : ([cmd.arch] as const)
        const objs: DesignObject[] = []
        for (const archName of archesWanted) {
          for (const spec of TOOTH_MANIFEST.filter((t) => t.arch === archName)) {
            const mesh = toothMesh(spec)
            const pose = archPose(spec)
            const lift = cmd.arch === 'both' && archName === 'upper' ? 16 : 0
            mesh.position.set(pose.x, lift, pose.z)
            mesh.rotation.y = pose.rotY
            if (lift) mesh.rotation.x = Math.PI // occlusal faces the bite
            objs.push({ id: newId(), kind: 'tooth', toothNumber: spec.number, mesh })
          }
        }
        addObject(objs[0], `build ${cmd.arch} arch`, objs)
        setStatus(`Built the ${cmd.arch === 'both' ? 'full' : cmd.arch} arch — ${objs.length} teeth from the library.`)
        break
      }
      case 'primitive': {
        const mesh = primitiveMesh(cmd.shape, cmd.dims)
        const n = world.cad.designObjects.length
        mesh.position.set((n % 5) * 22 - 44, 0, Math.floor(n / 5) * 22 - 22)
        addObject({ id: newId(), kind: 'waxup', mesh }, `add ${cmd.shape}`)
        setStatus(`Added ${mesh.name}.`)
        break
      }
      case 'move': {
        const done = transformCurrent(`move ${cmd.axis} ${cmd.mm}mm`, (m) => {
          m.position[cmd.axis] += cmd.mm
        })
        setStatus(done ? `Moved ${cmd.mm}mm along ${cmd.axis.toUpperCase()}.` : 'Nothing to move yet.')
        break
      }
      case 'rotate': {
        const rad = (cmd.deg * Math.PI) / 180
        const done = transformCurrent(`rotate ${cmd.deg}°`, (m) => {
          m.rotation[cmd.axis] += rad
        })
        setStatus(done ? `Rotated ${cmd.deg}° around ${cmd.axis.toUpperCase()}.` : 'Nothing to rotate yet.')
        break
      }
      case 'scale': {
        const f = cmd.factor > 0 ? cmd.factor : 1
        const done = transformCurrent(`scale ×${f}`, (m) => {
          m.scale.multiplyScalar(f)
        })
        setStatus(done ? `Scaled ×${f}.` : 'Nothing to scale yet.')
        break
      }
      case 'color': {
        const obj = currentObject()
        if (!obj) {
          setStatus('Nothing to color yet.')
          break
        }
        const mat = obj.mesh.material as THREE.MeshStandardMaterial
        const before = mat.color.getHex()
        mat.color.set(cmd.color)
        const after = mat.color.getHex()
        world.undo.push({
          label: `color ${cmd.color}`,
          undo: () => mat.color.setHex(before),
          redo: () => mat.color.setHex(after)
        })
        setStatus(`Colored ${obj.mesh.name || 'object'} ${cmd.color}.`)
        break
      }
      case 'duplicate': {
        const obj = currentObject()
        if (!obj) {
          setStatus('Nothing to duplicate yet.')
          break
        }
        const mesh = obj.mesh.clone()
        mesh.material = (obj.mesh.material as THREE.MeshStandardMaterial).clone()
        mesh.position.x += 14
        addObject({ id: newId(), kind: obj.kind, toothNumber: obj.toothNumber, mesh }, 'duplicate')
        setStatus(`Duplicated ${obj.mesh.name || 'object'}.`)
        break
      }
      case 'remove': {
        const obj = currentObject()
        if (!obj) {
          setStatus('Nothing to delete.')
          break
        }
        world.cad.removeDesignObject(obj.id)
        world.undo.push({
          label: `delete ${obj.mesh.name || obj.id}`,
          undo: () => {
            world.cad.addDesignObject(obj)
            syncCount()
          },
          redo: () => {
            world.cad.removeDesignObject(obj.id)
            syncCount()
          }
        })
        applySelection(null)
        syncCount()
        setStatus(`Deleted ${obj.mesh.name || 'object'}.`)
        break
      }
      case 'clear': {
        const all = [...world.cad.designObjects]
        if (!all.length) {
          setStatus('Already empty.')
          break
        }
        for (const o of all) world.cad.removeDesignObject(o.id)
        world.undo.push({
          label: 'clear',
          undo: () => {
            for (const o of all) world.cad.addDesignObject(o)
            syncCount()
          },
          redo: () => {
            for (const o of all) world.cad.removeDesignObject(o.id)
            syncCount()
          }
        })
        applySelection(null)
        syncCount()
        setStatus('Cleared the design.')
        break
      }
      case 'undo':
        setStatus(world.undo.undo() ? 'Undone.' : 'Nothing to undo.')
        syncCount()
        break
      case 'redo':
        setStatus(world.undo.redo() ? 'Redone.' : 'Nothing to redo.')
        syncCount()
        break
      case 'export':
        exportAll(cmd.format)
        break
      case 'import':
        fileInputRef.current?.click()
        break
      case 'grid': {
        const mode = nextGridMode(world.grid.mode)
        world.grid.setMode(mode)
        saveGridMode(mode)
        setStatus(`Grid: ${mode}.`)
        break
      }
      case 'help':
        setHelpOpen((v) => !v)
        break
      case 'unknown':
        setStatus(`Didn't catch that — “${cmd.text}”. Say “help” for what I understand.`)
        break
    }
  }

  function submit(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    runCommand(parse(trimmed))
    setInput('')
    setInterim('')
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const geometry = await parseGeometry(file)
      geometry.computeVertexNormals()
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: NEUTRAL_COLOR, roughness: 0.6, metalness: 0.05 })
      )
      mesh.name = file.name
      addObject({ id: newId(), kind: 'mesh', mesh, sourceName: file.name }, `import ${file.name}`)
      setStatus(`Imported ${file.name}.`)
    } catch (err) {
      setStatus(`Could not read ${file.name}: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  /* ── voice ───────────────────────────────────────────────────────────── */
  const dictationRef = useRef<ReturnType<typeof createDictation> | null>(null)
  if (!dictationRef.current && typeof window !== 'undefined') {
    dictationRef.current = createDictation({
      onInterim: (t) => setInterim(t),
      onFinal: (t) => {
        setInterim('')
        submit(t)
      },
      onStateChange: (on) => setListening(on),
      onError: (m) => setStatus(m)
    })
  }
  const dictation = dictationRef.current

  return (
    <div className="app">
      <header className="chrome">
        <span className="brand">SayCAD</span>
        <span className="tag">say it · see it · print it</span>
        <span className="spacer" />
        <span className="chip">{objectCount} object{objectCount === 1 ? '' : 's'}</span>
        {selectedLabel && <span className="chip sel">{selectedLabel}</span>}
        <button className="ghost" onClick={() => runCommand({ kind: 'undo' })} disabled={!canUndo}>Undo</button>
        <button className="ghost" onClick={() => runCommand({ kind: 'redo' })} disabled={!canRedo}>Redo</button>
        <button className="ghost" onClick={() => runCommand({ kind: 'import' })}>Import</button>
        <button className="ghost" onClick={() => runCommand({ kind: 'export', format: 'stl' })}>Export STL</button>
        <button className="ghost" onClick={() => runCommand({ kind: 'help' })}>Help</button>
      </header>

      <div className="viewport" ref={mountRef}>
        {helpOpen && (
          <aside className="help">
            <h2>What I understand</h2>
            <table>
              <tbody>
                {GRAMMAR_HELP.map(([say, does]) => (
                  <tr key={say}>
                    <td>“{say}”</td>
                    <td>{does}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="fineprint">
              Click an object to make it “it”. Drag to tumble, scroll to zoom, Shift-drag to pan, double-click to focus.
            </p>
          </aside>
        )}
        {(listening || interim) && (
          <div className="transcript">{interim || 'Listening…'}</div>
        )}
      </div>

      <footer className="commandbar">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit(input)
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder='Try “build an upper arch”, “add tooth 14”, “box 20 12 6”, “color it gold”, “export stl”…'
            aria-label="Command"
          />
          {dictation?.supported && (
            <button
              type="button"
              className={listening ? 'mic on' : 'mic'}
              title={listening ? 'Stop listening' : 'Speak a command'}
              onClick={() => (listening ? dictation.stop() : dictation.start())}
            >
              {listening ? '◼' : '🎙'}
            </button>
          )}
          <button type="submit" className="run">Make it</button>
        </form>
        <p className="status" role="status">{status}</p>
      </footer>

      <input ref={fileInputRef} type="file" accept=".stl,.ply" hidden onChange={onFilePicked} />
    </div>
  )
}
