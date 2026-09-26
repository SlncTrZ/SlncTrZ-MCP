import { describe, expect, it } from "vitest";
import { DebateWaiterRegistry } from "../../src/debate/waiters.js";

describe("DebateWaiterRegistry", () => {
  it("shares one notification per debate and keeps it alive until the last caller cancels", async () => {
    const registry = new DebateWaiterRegistry();
    const first = registry.register("debate-1");
    const second = registry.register("debate-1");
    first.cancel();

    let resolved = false;
    void second.promise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    registry.notify("debate-1");
    await second.promise;
    expect(resolved).toBe(true);

    const third = registry.register("debate-2");
    const fourth = registry.register("debate-2");
    third.cancel();
    fourth.cancel();

    const replacement = registry.register("debate-2");
    registry.notify("debate-2");
    await replacement.promise;
  });
});
