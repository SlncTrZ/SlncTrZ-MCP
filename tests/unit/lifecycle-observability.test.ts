import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeGatewayLifecycleIntent,
  writeGatewayLifecycleIntent
} from "../../src/observability/lifecycle-observability.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-lifecycle-intent-"));
  cleanup.push(root);
  return join(root, "lifecycle-intent.json");
}

describe("gateway lifecycle intent", () => {
  it("writes one secret-free restart intent and consumes it exactly once", async () => {
    const path = await fixture();
    const now = Date.parse("2026-09-21T00:00:00.000Z");
    const intent = await writeGatewayLifecycleIntent(path, "release_restart", {
      now: () => now,
      correlationId: () => "restart-correlation-1"
    });

    expect(intent).toEqual({
      reason: "release_restart",
      correlationId: "restart-correlation-1",
      createdAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-09-21T00:10:00.000Z"
    });
    expect(await readFile(path, "utf8")).not.toContain("passphrase");

    await expect(consumeGatewayLifecycleIntent(path, () => now + 1_000)).resolves.toEqual(intent);
    await expect(consumeGatewayLifecycleIntent(path, () => now + 2_000)).resolves.toBeUndefined();
  });

  it("drops expired or malformed intent instead of inventing a restart reason", async () => {
    const path = await fixture();
    await writeFile(
      path,
      JSON.stringify({
        reason: "release_restart",
        correlationId: "expired",
        createdAt: "2026-09-21T00:00:00.000Z",
        expiresAt: "2026-09-21T00:01:00.000Z"
      }),
      "utf8"
    );
    await expect(
      consumeGatewayLifecycleIntent(path, () => Date.parse("2026-09-21T00:02:00.000Z"))
    ).resolves.toBeUndefined();

    await writeFile(path, "{broken-json", "utf8");
    await expect(consumeGatewayLifecycleIntent(path)).resolves.toBeUndefined();
  });
});
