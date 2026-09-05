/**
 * Release Manifest Fetch — bounded HTTPS retrieval before standalone installation.
 * Wing: distribution | Topic: standalone-update | Updated: 2026-08-28
 *
 * Provenance: PLAN Phase 8 and ADR-008.
 */

import { fetchHttpsWithRedirects, validateHttpsUrl } from "./https-fetch.js";
import { parseReleaseManifest, type ReleaseManifest } from "./release-manifest.js";

export const DEFAULT_MAX_RELEASE_MANIFEST_BYTES = 1_048_576;

export function validateReleaseManifestUrl(value: string): URL {
  return validateHttpsUrl(value, "Release manifest URL");
}

async function readBoundedUtf8(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) throw new Error("Release manifest response has no body");
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^[0-9]+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    throw new Error("Release manifest response exceeds configured size limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Release manifest response exceeds configured size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    throw new Error("Release manifest response is not valid UTF-8");
  }
}

export async function fetchReleaseManifest(
  url: string,
  options: {
    readonly fetch?: typeof fetch;
    readonly maxBytes?: number;
    readonly signal?: AbortSignal;
  } = {}
): Promise<ReleaseManifest> {
  const parsedUrl = validateReleaseManifestUrl(url);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RELEASE_MANIFEST_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Release manifest size limit must be a positive safe integer");
  }
  const response = await fetchHttpsWithRedirects(parsedUrl, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    label: "Release manifest URL"
  });
  if (!response.ok) throw new Error("Release manifest download failed");
  let document: unknown;
  try {
    document = JSON.parse(await readBoundedUtf8(response, maxBytes)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Release manifest response is invalid JSON");
    throw error;
  }
  return parseReleaseManifest(document);
}
