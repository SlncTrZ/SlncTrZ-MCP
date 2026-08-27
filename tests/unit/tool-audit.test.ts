import { describe, expect, it } from "vitest";
import { createJsonLineToolAuditSink } from "../../src/observability/tool-audit.js";

describe("tool audit", () => {
  it("records attribution without path, content, token, or credential fields", () => {
    const lines: string[] = [];
    const sink = createJsonLineToolAuditSink((line) => lines.push(line));

    sink({
      timestamp: "2026-08-27T00:00:00.000Z",
      requestId: "request-1",
      clientId: "client-1",
      workspaceId: "workspace-main",
      toolId: "core.write",
      riskClass: "write",
      policyVersion: "policy-1",
      decision: "allow",
      result: "success",
      durationMs: 3
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      timestamp: "2026-08-27T00:00:00.000Z",
      requestId: "request-1",
      clientId: "client-1",
      workspaceId: "workspace-main",
      toolId: "core.write",
      riskClass: "write",
      policyVersion: "policy-1",
      decision: "allow",
      result: "success",
      durationMs: 3
    });
    expect(lines[0]).not.toMatch(/path|content|token|secret|credential/iu);
  });
});
