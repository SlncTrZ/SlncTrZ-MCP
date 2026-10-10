import { describe, expect, it } from "vitest";
import { providerIdentity } from "../../src/extension/provider-identity.js";

describe("provider handshake identity", () => {
  it("reports runtime identity, not configured manifest version or arbitrary metadata", () => {
    const result = providerIdentity(
      {
        serverInfo: { name: "example", version: "2.4.0", token: "private" },
        secret: "private"
      },
      "2025-11-25"
    );
    expect(result).toMatchObject({
      name: "example",
      version: "2.4.0",
      protocolVersion: "2025-11-25"
    });
    expect(Number.isNaN(Date.parse(result.observedAt))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("keeps missing identity unknown and rejects oversized/control-containing values", () => {
    expect(providerIdentity({}, "2026-07-28").version).toBeUndefined();
    expect(
      providerIdentity(
        { serverInfo: { name: "x".repeat(129), version: "bad\nvalue" } },
        "2026-07-28"
      )
    ).not.toHaveProperty("version");
    expect(
      providerIdentity({ serverInfo: { name: "x".repeat(129) } }, "2026-07-28")
    ).not.toHaveProperty("name");
  });
});
