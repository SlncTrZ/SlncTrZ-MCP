/**
 * Release Manifest Fetch — bounded HTTPS retrieval before standalone installation.
 * Wing: distribution | Topic: standalone-update | Updated: 2026-08-28
 *
 * Provenance: PLAN Phase 8 and ADR-008.
 */

import { fetchHttpsWithRedirects, validateHttpsUrl } from "./https-fetch.js";
import { parseReleaseManifest, type ReleaseManifest } from "./release-manifest.js";

export const DEFAULT_MAX_RELEASE_MANIFEST_BYTES = 1_048_576;
export const DEFAULT_RELEASE_MANIFEST_ATTEMPTS = 7;
export const DEFAULT_RELEASE_MANIFEST_RETRY_DELAY_MS = 5_000;
const MAX_RELEASE_MANIFEST_RETRY_DELAY_MS = 30_000;

function retryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function waitBeforeRetry(
  attempt: number,
  baseDelayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (baseDelayMs === 0) return;
  const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_RELEASE_MANIFEST_RETRY_DELAY_MS);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

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
    readonly attempts?: number;
    readonly retryDelayMs?: number;
  } = {}
): Promise<ReleaseManifest> {
  const parsedUrl = validateReleaseManifestUrl(url);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RELEASE_MANIFEST_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Release manifest size limit must be a positive safe integer");
  }
  const attempts = options.attempts ?? DEFAULT_RELEASE_MANIFEST_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RELEASE_MANIFEST_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("Release manifest attempts must be an integer from 1 to 10");
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30_000) {
    throw new Error("Release manifest retry delay must be an integer from 0 to 30000");
  }

  let response: Response | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    response = await fetchHttpsWithRedirects(parsedUrl, {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      label: "Release manifest URL"
    });
    if (response.ok || !retryableStatus(response.status) || attempt === attempts) break;
    await response.body?.cancel().catch(() => undefined);
    await waitBeforeRetry(attempt, retryDelayMs, options.signal);
  }
  if (response === undefined || !response.ok) {
    throw new Error("Release manifest download failed");
  }
  let document: unknown;
  try {
    document = JSON.parse(await readBoundedUtf8(response, maxBytes)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Release manifest response is invalid JSON");
    throw error;
  }
  return parseReleaseManifest(document);
}
