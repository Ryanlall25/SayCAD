/**
 * SayCAD undo/redo — a bounded command stack. Commands are closures built
 * by the editor at the moment the action completes (transform-drag end, tooth
 * placement, delete), so the stack itself needs no knowledge of the scene.
 * Transform commands capture {objectId, before, after} matrices inside their
 * closures; add/delete commands capture the DesignObject itself so redo can
 * re-attach the same mesh without re-parsing geometry.
 */

export interface UndoableCommand {
  /** Short human label, e.g. "move #19" — surfaced in the panel tooltip. */
  label: string
  undo(): void
  redo(): void
}

const MAX_ENTRIES = 100

export class UndoStack {
  private stack: UndoableCommand[] = []
  /** Points one past the last APPLIED command (undo walks left, redo right). */
  private index = 0
  private listeners = new Set<() => void>()

  /** Push an already-applied command. Truncates any redo tail; caps at 100
   *  entries by dropping the oldest (they become permanent). */
  push(cmd: UndoableCommand): void {
    this.stack.length = this.index
    this.stack.push(cmd)
    if (this.stack.length > MAX_ENTRIES) this.stack.shift()
    this.index = this.stack.length
    this.emit()
  }

  undo(): boolean {
    if (!this.canUndo) return false
    this.index -= 1
    this.stack[this.index].undo()
    this.emit()
    return true
  }

  redo(): boolean {
    if (!this.canRedo) return false
    this.stack[this.index].redo()
    this.index += 1
    this.emit()
    return true
  }

  get canUndo(): boolean {
    return this.index > 0
  }

  get canRedo(): boolean {
    return this.index < this.stack.length
  }

  get undoLabel(): string | null {
    return this.canUndo ? this.stack[this.index - 1].label : null
  }

  get redoLabel(): string | null {
    return this.canRedo ? this.stack[this.index].label : null
  }

  clear(): void {
    this.stack = []
    this.index = 0
    this.emit()
  }

  /** UI subscription (React syncs canUndo/canRedo badges from this). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }
}
