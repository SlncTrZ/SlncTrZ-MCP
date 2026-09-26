/** In-process event registry for bounded Debate waits. */

interface WaitRegistration {
  readonly promise: Promise<void>;
  cancel(): void;
}

interface DebateSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  refs: number;
}

export class DebateWaiterRegistry {
  readonly #waiters = new Map<string, DebateSignal>();
  #closed = false;

  register(debateId: string): WaitRegistration {
    if (this.#closed) {
      return { promise: Promise.resolve(), cancel: () => undefined };
    }

    let signal = this.#waiters.get(debateId);
    if (signal === undefined) {
      let resolvePromise!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
      });
      signal = { promise, resolve: resolvePromise, refs: 0 };
      this.#waiters.set(debateId, signal);
    }
    signal.refs += 1;

    let active = true;
    return {
      promise: signal.promise,
      cancel: () => {
        if (!active) return;
        active = false;
        const current = this.#waiters.get(debateId);
        if (current !== signal) return;
        current.refs -= 1;
        if (current.refs === 0) this.#waiters.delete(debateId);
      }
    };
  }

  notify(debateId: string): void {
    const signal = this.#waiters.get(debateId);
    if (signal === undefined) return;
    this.#waiters.delete(debateId);
    signal.resolve();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const debateId of [...this.#waiters.keys()]) this.notify(debateId);
    this.#waiters.clear();
  }
}
