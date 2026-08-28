/**
 * Wing: observability | Topic: authentication-audit | Updated: 2026-08-26
 */

import { describe, expect, it } from "vitest";
import { createAuditJournal } from "../../src/observability/audit-journal.js";
import {
  createJournalAuthAuditSink,
  createJsonLineAuthAuditSink
} from "../../src/observability/auth-audit.js";
import { createMetricsRegistry } from "../../src/observability/metrics.js";

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

    const journal = createAuditJournal({ capacity: 2 });
    const metrics = createMetricsRegistry();
    const fanOut = createJournalAuthAuditSink(journal, sink, metrics);
    fanOut({
      timestamp: "2026-08-28T00:00:00.000Z",
      type: "authorization.failed",
      outcome: "failure",
      clientId: "client_public",
      reason: "invalid_owner",
      operation: "owner_authentication"
    });

    expect(journal.export()).toEqual([
      {
        timestamp: "2026-08-28T00:00:00.000Z",
        category: "auth",
        clientId: "client_public",
        capabilityId: "authorization.failed",
        result: "error"
      }
    ]);
    expect(metrics.snapshot().authFailuresTotal).toBe(1);
    expect(JSON.stringify(journal.export())).not.toMatch(
      /invalid_owner|owner_authentication|token_value|client_secret|passphrase/iu
    );
  });
});
