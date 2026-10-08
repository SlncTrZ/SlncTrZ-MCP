import { describe, expect, it } from "vitest";
import {
  buildExtensionStructuredContent,
  deliverToolResult
} from "../../src/protocol/mcp-server.js";

describe("buildExtensionStructuredContent", () => {
  it("decodes a JSON text payload alongside truncated", () => {
    const parsed = buildExtensionStructuredContent(
      '{"status":"ok","docker":true,"uptime":1234}',
      false
    );
    expect(parsed).toEqual({
      truncated: false,
      status: "ok",
      docker: true,
      uptime: 1234
    });
  });

  it("carries the raw result for non-JSON text", () => {
    expect(buildExtensionStructuredContent("pong", false)).toEqual({
      truncated: false,
      text: "pong"
    });
    expect(buildExtensionStructuredContent("provider_timeout", true)).toEqual({
      truncated: true,
      text: "provider_timeout"
    });
  });

  it("keeps {truncated} for empty text", () => {
    expect(buildExtensionStructuredContent("", false)).toEqual({ truncated: false });
  });

  it("carries a JSON array or scalar as raw text", () => {
    expect(buildExtensionStructuredContent("[1,2,3]", false)).toEqual({
      truncated: false,
      text: "[1,2,3]"
    });
    expect(buildExtensionStructuredContent("42", false)).toEqual({
      truncated: false,
      text: "42"
    });
  });

  it("falls back on malformed JSON", () => {
    expect(buildExtensionStructuredContent("{not json", false)).toEqual({
      truncated: false,
      text: "{not json"
    });
  });
});

describe("connection result delivery", () => {
  it("supplies complete bounded output and metadata to text-only consumers without losing media", () => {
    const structuredContent = {
      stdout: "output",
      stderr: "failure",
      exitCode: 2,
      timedOut: false,
      stdoutTruncated: true
    };
    const image = { type: "image" as const, data: "fixture", mimeType: "image/png" };
    const result = {
      isError: true,
      _meta: { receipt: "fixture" },
      content: [{ type: "text" as const, text: "exit 2" }, image],
      structuredContent
    };
    expect(deliverToolResult(result, "structured")).toBe(result);
    const full = deliverToolResult(result, "full-content");
    const last = full.content.at(-1);
    expect(JSON.parse(last?.type === "text" ? last.text : "")).toEqual(structuredContent);
    expect(full.content[1]).toBe(image);
    expect(full.isError).toBe(true);
    expect(full._meta).toEqual(result._meta);
    expect(deliverToolResult(full, "full-content").content).toHaveLength(3);
  });
  it("preserves text errors and protocol input-required results with no structured payload", () => {
    const error = { isError: true, content: [{ type: "text", text: "denied" }] };
    expect(deliverToolResult(error, "full-content")).toBe(error);
    const input = { resultType: "input_required", requests: [] };
    expect(deliverToolResult(input, "full-content")).toBe(input);
  });
});
