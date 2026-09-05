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

  it("propagates abort signals and rejects interrupted or invalid-UTF-8 streams", async () => {
    const controller = new AbortController();
    const aborting = (async (_url: URL, options?: RequestInit) => {
      expect(options?.redirect).toBe("manual");
      expect(options?.signal).toBe(controller.signal);
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;
    await expect(
      fetchReleaseManifest("https://updates.example.test/stable.json", {
        fetch: aborting,
        signal: controller.signal
      })
    ).rejects.toThrow("aborted");

    const interrupted = (async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"schemaVersion":'));
            stream.error(new Error("simulated manifest stream reset"));
          }
        }),
        { status: 200 }
      )) as typeof fetch;
    await expect(
      fetchReleaseManifest("https://updates.example.test/stable.json", { fetch: interrupted })
    ).rejects.toThrow("simulated manifest stream reset");

    await expect(
      fetchReleaseManifest("https://updates.example.test/stable.json", {
        fetch: responder(new Uint8Array([0xff]))
      })
    ).rejects.toThrow("valid UTF-8");
  });

  it("follows bounded HTTPS redirects and rejects downgrade/loops", async () => {
    const redirected = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === "https://updates.example.test/stable.json") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://objects.example.test/release.json" }
        });
      }
      return new Response(document, { status: 200 });
    }) as typeof fetch;
    await expect(
      fetchReleaseManifest("https://updates.example.test/stable.json", { fetch: redirected })
    ).resolves.toMatchObject({ version: "1.2.3" });

    const downgrade = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://unsafe.example/release.json" }
      })) as typeof fetch;
    await expect(
      fetchReleaseManifest("https://updates.example.test/stable.json", { fetch: downgrade })
    ).rejects.toThrow("HTTPS");

    const loop = (async () =>
      new Response(null, { status: 302, headers: { location: "/stable.json" } })) as typeof fetch;
    await expect(
      fetchReleaseManifest("https://updates.example.test/stable.json", { fetch: loop })
    ).rejects.toThrow("loop");
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
