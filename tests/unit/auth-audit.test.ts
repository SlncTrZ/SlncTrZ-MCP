/**
 * Wing: observability | Topic: authentication-audit | Updated: 2026-08-26
 */

import { describe, expect, it } from "vitest";
import { createJsonLineAuthAuditSink } from "../../src/observability/auth-audit.js";

describe("authentication audit", () => {
  it("writes one structured JSON line without inventing sensitive fields", () => {
    const lines: string[] = [];
    const sink = createJsonLineAuthAuditSink((line) => lines.push(line));

    sink({
      timestamp: "2026-08-26T00:00:00.000Z",
      type: "token.revoked",
      outcome: "success",
      clientId: "client_public"
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      timestamp: "2026-08-26T00:00:00.000Z",
      type: "token.revoked",
      outcome: "success",
      clientId: "client_public"
    });
    expect(lines[0]).not.toMatch(/token_value|client_secret|passphrase|authorization/iu);
  });
});
