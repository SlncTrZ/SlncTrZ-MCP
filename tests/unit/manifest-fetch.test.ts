import { describe, expect, it } from "vitest";
import {
  fetchReleaseManifest,
  releaseManifestSignatureUrl,
  validateReleaseManifestUrl
} from "../../src/standalone/manifest-fetch.js";
import { TEST_RELEASE_TRUST_KEYS, releaseSignatureDocument } from "../helpers/release-signing.js";

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

function signedResponder(body: string | Uint8Array, status = 200): typeof fetch {
  return (async (input) => {
    if (String(input).endsWith(".sig")) {
      return new Response(releaseSignatureDocument(body), { status: 200 });
    }
    return new Response(body, { status });
  }) as typeof fetch;
}

function fetchSigned(
  url: string,
  options: Omit<Parameters<typeof fetchReleaseManifest>[1], "trustedKeys"> = {}
) {
  return fetchReleaseManifest(url, { ...options, trustedKeys: TEST_RELEASE_TRUST_KEYS });
}

describe("release manifest retrieval", () => {
  it("retrieves and verifies a bounded publisher-signed HTTPS manifest", async () => {
    await expect(
      fetchSigned("https://updates.example.test/stable.json", { fetch: signedResponder(document) })
    ).resolves.toMatchObject({ version: "1.2.3" });
    expect(
      releaseManifestSignatureUrl(new URL("https://updates.example.test/stable.json")).href
    ).toBe("https://updates.example.test/stable.json.sig");
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
      fetchSigned("https://updates.example.test/stable.json", {
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
      fetchSigned("https://updates.example.test/stable.json", { fetch: interrupted })
    ).rejects.toThrow("simulated manifest stream reset");

    const invalidUtf8 = new Uint8Array([0xff]);
    await expect(
      fetchSigned("https://updates.example.test/stable.json", {
        fetch: signedResponder(invalidUtf8)
      })
    ).rejects.toThrow("valid UTF-8");
  });

  it("follows bounded HTTPS redirects for both manifest and signature", async () => {
    const redirected = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === "https://updates.example.test/stable.json") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://objects.example.test/release.json" }
        });
      }
      if (url === "https://updates.example.test/stable.json.sig") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://objects.example.test/release.json.sig" }
        });
      }
      if (url.endsWith(".sig")) {
        return new Response(releaseSignatureDocument(document), { status: 200 });
      }
      return new Response(document, { status: 200 });
    }) as typeof fetch;
    await expect(
      fetchSigned("https://updates.example.test/stable.json", { fetch: redirected })
    ).resolves.toMatchObject({ version: "1.2.3" });

    const downgrade = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://unsafe.example/release.json" }
      })) as typeof fetch;
    await expect(
      fetchSigned("https://updates.example.test/stable.json", { fetch: downgrade })
    ).rejects.toThrow("HTTPS");

    const loop = (async () =>
      new Response(null, { status: 302, headers: { location: "/stable.json" } })) as typeof fetch;
    await expect(
      fetchSigned("https://updates.example.test/stable.json", { fetch: loop })
    ).rejects.toThrow("loop");
  });

  it("retries transient manifest and signature failures but not permanent errors", async () => {
    let manifestCalls = 0;
    let signatureCalls = 0;
    const transient = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith(".sig")) {
        signatureCalls += 1;
        return signatureCalls < 2
          ? new Response("temporary", { status: 503 })
          : new Response(releaseSignatureDocument(document), { status: 200 });
      }
      manifestCalls += 1;
      return manifestCalls < 3
        ? new Response("temporary", { status: 504 })
        : new Response(document, { status: 200 });
    }) as typeof fetch;
    await expect(
      fetchSigned("https://updates.example.test/stable.json", {
        fetch: transient,
        retryDelayMs: 0
      })
    ).resolves.toMatchObject({ version: "1.2.3" });
    expect(manifestCalls).toBe(3);
    expect(signatureCalls).toBe(2);

    let permanentCalls = 0;
    const permanent = (async () => {
      permanentCalls += 1;
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    await expect(
      fetchSigned("https://updates.example.test/stable.json", {
        fetch: permanent,
        retryDelayMs: 0
      })
    ).rejects.toThrow("download failed");
    expect(permanentCalls).toBe(1);
  });

  it("retries transient fetch rejections but never retries cancellation", async () => {
    let networkCalls = 0;
    const intermittent = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith(".sig")) {
        return new Response(releaseSignatureDocument(document), { status: 200 });
      }
      networkCalls += 1;
      if (networkCalls < 3) throw new TypeError("fetch failed");
      return new Response(document, { status: 200 });
    }) as typeof fetch;
    await expect(
      fetchSigned("https://updates.example.test/stable.json", {
        fetch: intermittent,
        retryDelayMs: 0
      })
    ).resolves.toMatchObject({ version: "1.2.3" });
    expect(networkCalls).toBe(3);

    let abortCalls = 0;
    const cancelled = (async () => {
      abortCalls += 1;
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;
    await expect(
      fetchSigned("https://updates.example.test/stable.json", {
        fetch: cancelled,
        retryDelayMs: 0
      })
    ).rejects.toThrow("aborted");
    expect(abortCalls).toBe(1);
  });

  it("rejects failed, oversized and malformed responses", async () => {
    await expect(
      fetchSigned("https://updates.example.test/stable.json", {
        fetch: signedResponder("no", 503),
        attempts: 2,
        retryDelayMs: 0
      })
    ).rejects.toThrow("download failed");
    await expect(
      fetchSigned("https://updates.example.test/stable.json", {
        fetch: signedResponder(document),
        maxBytes: 10
      })
    ).rejects.toThrow("size limit");
    await expect(
      fetchSigned("https://updates.example.test/stable.json", { fetch: signedResponder("{") })
    ).rejects.toThrow("invalid JSON");
  });

  it("fails closed for tampered bytes, signatures, unknown keys and missing trust roots", async () => {
    const tamperedManifest = (async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith(".sig")
        ? new Response(releaseSignatureDocument(document), { status: 200 })
        : new Response(document.replace("1.2.3", "1.2.4"), { status: 200 })) as typeof fetch;
    await expect(
      fetchSigned("https://updates.example.test/stable.json", { fetch: tamperedManifest })
    ).rejects.toThrow("verification failed");

    const validEnvelope = JSON.parse(releaseSignatureDocument(document)) as {
      schemaVersion: number;
      algorithm: string;
      keyId: string;
      signature: string;
    };
    const badSignature = (async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith(".sig")
        ? new Response(
            JSON.stringify({
              ...validEnvelope,
              signature: `A${validEnvelope.signature.slice(1)}`
            }),
            { status: 200 }
          )
        : new Response(document, { status: 200 })) as typeof fetch;
    await expect(
      fetchSigned("https://updates.example.test/stable.json", { fetch: badSignature })
    ).rejects.toThrow();

    const unknownKey = (async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith(".sig")
        ? new Response(
            JSON.stringify({
              ...validEnvelope,
              keyId: "ed25519-sha256-00000000000000000000000000000000"
            }),
            { status: 200 }
          )
        : new Response(document, { status: 200 })) as typeof fetch;
    await expect(
      fetchSigned("https://updates.example.test/stable.json", { fetch: unknownKey })
    ).rejects.toThrow("not trusted");

    await expect(
      fetchReleaseManifest("https://updates.example.test/stable.json", {
        fetch: signedResponder(document),
        trustedKeys: []
      })
    ).rejects.toThrow("trust_root_unconfigured");
  });
});
