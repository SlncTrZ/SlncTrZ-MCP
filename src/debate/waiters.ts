/** In-process event registry for bounded Debate waits. */

interface WaitRegistration {
  readonly promise: Promise<void>;
  cancel(): void;
}

export class DebateWaiterRegistry {
  readonly #waiters = new Map<string, Set<() => void>>();
  #closed = false;

  register(debateId: string): WaitRegistration {
    if (this.#closed) {
      return { promise: Promise.resolve(), cancel: () => undefined };
    }

    let active = true;
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    const callback = (): void => {
      if (!active) return;
      active = false;
      this.#remove(debateId, callback);
      resolvePromise();
    };
    let set = this.#waiters.get(debateId);
    if (set === undefined) {
      set = new Set();
      this.#waiters.set(debateId, set);
    }
    set.add(callback);

    return {
      promise,
      cancel: () => {
        if (!active) return;
        active = false;
        this.#remove(debateId, callback);
      }
    };
  }

  notify(debateId: string): void {
    const set = this.#waiters.get(debateId);
    if (set === undefined) return;
    for (const callback of [...set]) callback();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const debateId of [...this.#waiters.keys()]) this.notify(debateId);
    this.#waiters.clear();
  }

  #remove(debateId: string, callback: () => void): void {
    const set = this.#waiters.get(debateId);
    if (set === undefined) return;
    set.delete(callback);
    if (set.size === 0) this.#waiters.delete(debateId);
  }
}
