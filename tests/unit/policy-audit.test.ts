import { describe, expect, it } from "vitest";
import {
  type PolicyAuditEvent,
  createJsonLinePolicyAuditSink,
  serializePolicyAuditEvent
} from "../../src/observability/policy-audit.js";

const baseEvent: PolicyAuditEvent = {
  timestamp: "2026-08-27T08:00:00.000Z",
  eventType: "policy_reload",
  actorKind: "internal_reload",
  previousVersion: "aaaaaaaaaaaaaaaa",
  candidateVersion: "bbbbbbbbbbbbbbbb",
  activeVersion: "aaaaaaaaaaaaaaaa",
  result: "activated",
  riskIncrease: true,
  workspaceCount: 3,
  bindingCount: 2,
  durationMs: 12
};

describe("policy audit (one event, secret-free)", () => {
  it("serializes all audit fields deterministically", () => {
    const line = serializePolicyAuditEvent(baseEvent);
    const parsed = JSON.parse(line) as PolicyAuditEvent;
    expect(parsed).toEqual(baseEvent);
    expect(parsed.eventType).toBe("policy_reload");
    expect(parsed.actorKind).toBe("internal_reload");
    expect(parsed.riskIncrease).toBe(true);
    expect(parsed.workspaceCount).toBe(3);
    expect(parsed.bindingCount).toBe(2);
  });

  it("does not leak paths, roots, client binding ids, command ids, values, or secrets", () => {
    const line = serializePolicyAuditEvent({
      ...baseEvent,
      previousVersion: "abc123def456",
      candidateVersion: "fed654cba321",
      activeVersion: "abc123def456"
    });
    const forbidden = [
      "/home/",
      "/workspace",
      "write-root",
      "read-root",
      "client-binding",
      "command-id",
      "commandId",
      "clientId",
      "secret",
      "SECRET",
      "alpha.txt",
      "my-policy.json"
    ];
    for (const fragment of forbidden) {
      expect(line).not.toContain(fragment);
    }
    expect(line).toMatch(/"previousVersion":"[a-f0-9]+"/u);
    expect(line).toMatch(/"candidateVersion":"[a-f0-9]+"/u);
  });

  it("allowed actorKind values are startup or internal_reload", () => {
    for (const actorKind of ["startup", "internal_reload"] as const) {
      const line = serializePolicyAuditEvent({ ...baseEvent, actorKind });
      expect(JSON.parse(line)).toMatchObject({ actorKind });
    }
  });

  it("writes one JSON line via the sink", () => {
    const lines: string[] = [];
    const sink = createJsonLinePolicyAuditSink((line) => lines.push(line));
    sink(baseEvent);
    sink({ ...baseEvent, result: "approval_required" });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ result: "activated" });
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ result: "approval_required" });
  });
});
