// A tiny typed listener set: on() returns the unsubscribe; emit() iterates a
// copy so listeners may unsubscribe (or subscribe) while being notified.

export class Emitter<Args extends unknown[] = []> {
  #listeners = new Set<(...args: Args) => void>()

  on(listener: (...args: Args) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  emit(...args: Args): void {
    for (const listener of [...this.#listeners]) listener(...args)
  }

  get size(): number {
    return this.#listeners.size
  }
}
