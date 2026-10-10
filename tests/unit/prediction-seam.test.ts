import { describe, it, expect, vi } from "vitest";
import {
  assessmentForAuditResult,
  buildPredictionArgs,
  extractPredictionId,
  isSeamEligible,
  isSeamEnabled,
  recordSeamPrediction,
  resolveSeamPrediction,
  type SeamRuntime
} from "../../src/extension/prediction-seam.js";
import type { ExtensionCallResult } from "../../src/extension/adapter.js";

function okResult(text: string): ExtensionCallResult {
  return { isError: false, truncated: false, text };
}

function errResult(text: string): ExtensionCallResult {
  return { isError: true, truncated: false, text };
}

function runtimeWith(cyberbrain: {
  invoke: (toolId: string, args: unknown) => Promise<ExtensionCallResult>;
  ready?: boolean;
}): SeamRuntime & { calls: { toolId: string; args: unknown }[] } {
  const calls: { toolId: string; args: unknown }[] = [];
  return {
    calls,
    isReady: (providerId: string) =>
      providerId === "cyberbrain" ? (cyberbrain.ready ?? true) : true,
    provider: (providerId: string) =>
      providerId === "cyberbrain"
        ? {
            state: "ready" as const,
            start: async () => {
              /* test double: no startup work */
            },
            health: () => "ready" as const,
            stop: async () => {
              /* test double: no shutdown work */
            },
            invoke: async (toolId: string, args: unknown) => {
              calls.push({ toolId, args });
              return cyberbrain.invoke(toolId, args);
            }
          }
        : undefined
  };
}

const NOW = new Date("2026-10-10T03:30:00.000Z");

describe("prediction-seam eligibility", () => {
  it("accepts mutating tools on other providers", () => {
    expect(isSeamEligible("cdt-autocad.entity_create_line", "write")).toBe(true);
    expect(isSeamEligible("cdt-autocad.object_delete", "execute")).toBe(true);
  });

  it("rejects read-only tools", () => {
    expect(isSeamEligible("cdt-autocad.object_list", "read")).toBe(false);
  });

  it("rejects every cyberbrain tool including learning tools", () => {
    expect(isSeamEligible("cyberbrain.knowledge_search", "read")).toBe(false);
    expect(isSeamEligible("cyberbrain.memory_store", "write")).toBe(false);
    expect(isSeamEligible("cyberbrain.prediction_record", "write")).toBe(false);
    expect(isSeamEligible("cyberbrain.prediction_resolve", "write")).toBe(false);
    expect(isSeamEligible("cyberbrain.dream_enqueue", "execute")).toBe(false);
  });

  it("reads the environment flag", () => {
    expect(isSeamEnabled({ SLNCTRZ_PREDICTION_SEAM_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(
      true
    );
    expect(isSeamEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isSeamEnabled({ SLNCTRZ_PREDICTION_SEAM_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(
      false
    );
  });
});

describe("prediction-seam payloads", () => {
  it("builds bounded args without caller payload", () => {
    const args = buildPredictionArgs({
      canonicalId: "cdt-autocad.object_delete",
      riskClass: "execute",
      clientId: "client_1",
      correlationId: "req-9",
      now: NOW
    });
    expect(args).toMatchObject({
      confidence: 0.6,
      action: "cdt-autocad.object_delete",
      session_id: "gateway-seam/client_1/2026-10-10",
      event_time: "2026-10-10T03:30:00.000Z",
      topic: "gateway-prediction-seam",
      correlation_id: "req-9"
    });
    expect(JSON.stringify(args)).not.toContain("secret");
  });

  it("maps audit outcomes honestly", () => {
    expect(assessmentForAuditResult("success")).toBe("confirmed");
    expect(assessmentForAuditResult("error")).toBe("contradicted");
    expect(assessmentForAuditResult("timeout")).toBe("indeterminate");
    expect(assessmentForAuditResult("cancelled")).toBe("indeterminate");
  });

  it("extracts the prediction id only from well-formed payloads", () => {
    expect(extractPredictionId(JSON.stringify({ id: "p-1" }))).toBe("p-1");
    expect(extractPredictionId("not-json")).toBeUndefined();
    expect(extractPredictionId(JSON.stringify({ outcome: "x" }))).toBeUndefined();
  });
});

describe("prediction-seam flow", () => {
  it("records then resolves confirmed on success", async () => {
    const runtime = runtimeWith({
      invoke: async (toolId: string) =>
        toolId === "prediction_record"
          ? okResult(JSON.stringify({ id: "pred-1" }))
          : okResult(JSON.stringify({ ok: true }))
    });
    const id = await recordSeamPrediction(runtime, {
      canonicalId: "cdt-autocad.object_delete",
      riskClass: "execute",
      clientId: "c",
      correlationId: "r",
      now: NOW
    });
    expect(id).toBe("pred-1");
    await resolveSeamPrediction(runtime, id, "success", NOW);
    expect(runtime.calls.map((call) => call.toolId)).toEqual([
      "prediction_record",
      "prediction_resolve"
    ]);
    const resolveArgs = runtime.calls[1]?.args as { assessment?: unknown };
    expect(resolveArgs.assessment).toBe("confirmed");
  });

  it("resolves contradicted on error and indeterminate on timeout", async () => {
    const runtime = runtimeWith({
      invoke: async (toolId: string) =>
        toolId === "prediction_record"
          ? okResult(JSON.stringify({ id: "pred-2" }))
          : okResult(JSON.stringify({ ok: true }))
    });
    await resolveSeamPrediction(runtime, "pred-2", "error", NOW);
    await resolveSeamPrediction(runtime, "pred-2", "timeout", NOW);
    const assessments = runtime.calls.map(
      (call) => (call.args as { assessment?: unknown }).assessment
    );
    expect(assessments).toEqual(["contradicted", "indeterminate"]);
  });

  it("skips ineligible tools and unready backend", async () => {
    const runtime = runtimeWith({ invoke: async () => okResult("{}") });
    expect(
      await recordSeamPrediction(runtime, {
        canonicalId: "cdt-autocad.object_list",
        riskClass: "read",
        clientId: "c",
        correlationId: "r",
        now: NOW
      })
    ).toBeUndefined();
    expect(
      await recordSeamPrediction(runtime, {
        canonicalId: "cyberbrain.memory_store",
        riskClass: "write",
        clientId: "c",
        correlationId: "r",
        now: NOW
      })
    ).toBeUndefined();
    const down = runtimeWith({ invoke: async () => okResult("{}"), ready: false });
    expect(
      await recordSeamPrediction(down, {
        canonicalId: "cdt-autocad.object_delete",
        riskClass: "execute",
        clientId: "c",
        correlationId: "r",
        now: NOW
      })
    ).toBeUndefined();
    expect(runtime.calls).toEqual([]);
  });

  it("never throws when the seam backend fails", async () => {
    const failing = runtimeWith({
      invoke: async () => {
        throw new Error("boom");
      }
    });
    await expect(
      recordSeamPrediction(failing, {
        canonicalId: "cdt-autocad.object_delete",
        riskClass: "execute",
        clientId: "c",
        correlationId: "r",
        now: NOW
      })
    ).resolves.toBeUndefined();
    await expect(resolveSeamPrediction(failing, "pred-x", "success", NOW)).resolves.toBeUndefined();
    const malformed = runtimeWith({ invoke: async () => errResult("provider_unavailable") });
    await expect(
      recordSeamPrediction(malformed, {
        canonicalId: "cdt-autocad.object_delete",
        riskClass: "execute",
        clientId: "c",
        correlationId: "r",
        now: NOW
      })
    ).resolves.toBeUndefined();
    expect(vi.fn()).not.toHaveBeenCalled();
  });
});

describe("prediction-seam latency isolation", () => {
  const input = {
    canonicalId: "sample.mutate",
    riskClass: "write" as const,
    clientId: "c",
    correlationId: "r",
    now: NOW
  };

  it("bounds recording even when the backend ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const backend = runtimeWith({ invoke: async () => new Promise(() => undefined) });
      void recordSeamPrediction(backend, input).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1100);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds resolution even when the backend never returns", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const backend = runtimeWith({ invoke: async () => new Promise(() => undefined) });
      void resolveSeamPrediction(backend, "pred-x", "success", NOW).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1100);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
