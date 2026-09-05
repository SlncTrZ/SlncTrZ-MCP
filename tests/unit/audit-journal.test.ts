import { describe, expect, it } from "vitest";
import {
  createAuditJournal,
  type ExportableAuditEvent
} from "../../src/observability/audit-journal.js";

const event = (requestId: string): ExportableAuditEvent => ({
  timestamp: "2026-08-28T00:00:00.000Z",
  category: "tool",
  requestId,
  clientId: "client-1",
  workspaceId: "workspace-1",
  capabilityId: "core.read",
  policyVersion: "policy-1",
  result: "success",
  durationMs: 3
});

describe("audit journal", () => {
  it("retains a bounded chronological export without source payload", () => {
    const journal = createAuditJournal({ capacity: 2 });
    journal.append(event("one"));
    journal.append(event("two"));
    journal.append(event("three"));

    expect(journal.export()).toEqual([event("two"), event("three")]);
    expect(JSON.stringify(journal.export())).not.toMatch(/token|secret|credential|path|content/iu);
  });

  it("projects the reviewed schema and drops untyped source payload", () => {
    const journal = createAuditJournal({ capacity: 1 });
    journal.append({
      ...event("one"),
      ...({ path: "/private/file", token: "never-export" } as unknown as ExportableAuditEvent)
    });

    expect(journal.export()).toEqual([event("one")]);
  });

  it("rejects invalid export limits", () => {
    const journal = createAuditJournal({ capacity: 1 });
    expect(() => journal.export({ limit: -1 })).toThrow("non-negative");
    expect(() => journal.export({ limit: Number.NaN })).toThrow("safe integer");
    expect(() => journal.export({ limit: 1.5 })).toThrow("safe integer");
  });

  it("returns immutable exported records and bounds export count", () => {
    const journal = createAuditJournal({ capacity: 3 });
    journal.append(event("one"));
    journal.append(event("two"));
    const exported = journal.export({ limit: 1 });

    expect(exported).toEqual([event("two")]);
    expect(Object.isFrozen(exported)).toBe(true);
    expect(Object.isFrozen(exported[0])).toBe(true);
  });
});
