import { describe, expect, it } from "vitest";
import { buildExtensionStructuredContent } from "../../src/protocol/mcp-server.js";

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
