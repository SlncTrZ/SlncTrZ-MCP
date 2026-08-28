import { describe, expect, it } from "vitest";
import {
  fetchReleaseManifest,
  validateReleaseManifestUrl
} from "../../src/standalone/manifest-fetch.js";

const document = JSON.stringify({
  schemaVersion: 1,
  version: "1.2.3",
  artifacts: [
    {
      target: "linux-x64",
      url: "https://downloads.example.test/slnctrz-mcp",
      sha256: "a".repeat(64),
      sizeBytes: 1,
      fileName: "slnctrz-mcp"
    }
  ]
});

function responder(body: string | Uint8Array, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

describe("release manifest retrieval", () => {
  it("retrieves a bounded strict HTTPS manifest without redirects", async () => {
    await expect(
      fetchReleaseManifest("https://updates.example.test/stable.json", {
        fetch: responder(document)
      })
    ).resolves.toMatchObject({ version: "1.2.3" });
  });

  it("rejects unsafe URL forms before issuing a request", () => {
    expect(() => validateReleaseManifestUrl("http://updates.example.test/stable.json")).toThrow(
      "HTTPS"
    );
    expect(() =>
      validateReleaseManifestUrl("https://user:pass@updates.example.test/stable.json")
    ).toThrow("userinfo");
  });

  it("rejects failed, oversized and malformed responses", async () => {
    await expect(
      fetchReleaseManifest("https://updates.example.test/stable.json", {
        fetch: responder("no", 503)
      })
    ).rejects.toThrow("download failed");
    await expect(
      fetchReleaseManifest("https://updates.example.test/stable.json", {
        fetch: responder(document),
        maxBytes: 10
      })
    ).rejects.toThrow("size limit");
    await expect(
      fetchReleaseManifest("https://updates.example.test/stable.json", { fetch: responder("{") })
    ).rejects.toThrow("invalid JSON");
  });
});
