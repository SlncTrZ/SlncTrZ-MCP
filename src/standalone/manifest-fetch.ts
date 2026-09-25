/**
 * Release Manifest Fetch — bounded HTTPS retrieval plus publisher-authentic signature verification.
 * Wing: distribution | Topic: standalone-update | Updated: 2026-09-24
 */

import {
  fetchHttpsWithRedirects,
  isTransientFetchError,
  validateHttpsUrl,
  waitForNetworkRetry
} from "./https-fetch.js";
import { parseReleaseManifest, type ReleaseManifest } from "./release-manifest.js";
import {
  embeddedReleaseTrustKeys,
  parseReleaseSignatureEnvelope,
  verifyReleaseManifestSignature,
  type ReleaseTrustKey
} from "./release-signature.js";

export const DEFAULT_MAX_RELEASE_MANIFEST_BYTES = 1_048_576;
export const DEFAULT_MAX_RELEASE_SIGNATURE_BYTES = 16_384;
export const DEFAULT_RELEASE_MANIFEST_ATTEMPTS = 7;
export const DEFAULT_RELEASE_MANIFEST_RETRY_DELAY_MS = 5_000;
const MAX_RELEASE_MANIFEST_RETRY_DELAY_MS = 30_000;

function retryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function validateReleaseManifestUrl(value: string): URL {
  return validateHttpsUrl(value, "Release manifest URL");
}

export function releaseManifestSignatureUrl(manifestUrl: URL): URL {
  const signatureUrl = new URL(manifestUrl.href);
  signatureUrl.pathname = `${signatureUrl.pathname}.sig`;
  return signatureUrl;
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  label: string
): Promise<Uint8Array> {
  if (response.body === null) throw new Error(`${label} response has no body`);
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^[0-9]+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    throw new Error(`${label} response exceeds configured size limit`);
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
        throw new Error(`${label} response exceeds configured size limit`);
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
  return merged;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} response is not valid UTF-8`);
  }
}

async function fetchBoundedHttpsBytes(
  parsedUrl: URL,
  options: {
    readonly fetch?: typeof fetch;
    readonly maxBytes: number;
    readonly signal?: AbortSignal;
    readonly attempts: number;
    readonly retryDelayMs: number;
    readonly label: string;
  }
): Promise<Uint8Array> {
  let response: Response | undefined;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      response = await fetchHttpsWithRedirects(parsedUrl, {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        label: options.label
      });
    } catch (error) {
      if (!isTransientFetchError(error) || attempt === options.attempts) throw error;
      await waitForNetworkRetry(
        attempt,
        options.retryDelayMs,
        MAX_RELEASE_MANIFEST_RETRY_DELAY_MS,
        options.signal
      );
      continue;
    }
    if (response.ok || !retryableStatus(response.status) || attempt === options.attempts) break;
    await response.body?.cancel().catch(() => undefined);
    await waitForNetworkRetry(
      attempt,
      options.retryDelayMs,
      MAX_RELEASE_MANIFEST_RETRY_DELAY_MS,
      options.signal
    );
  }
  if (response === undefined || !response.ok) {
    throw new Error(`${options.label} download failed`);
  }
  return readBoundedBytes(response, options.maxBytes, options.label);
}

export async function fetchReleaseManifest(
  url: string,
  options: {
    readonly fetch?: typeof fetch;
    readonly maxBytes?: number;
    readonly maxSignatureBytes?: number;
    readonly signal?: AbortSignal;
    readonly attempts?: number;
    readonly retryDelayMs?: number;
    readonly trustedKeys?: readonly ReleaseTrustKey[];
  } = {}
): Promise<ReleaseManifest> {
  const parsedUrl = validateReleaseManifestUrl(url);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RELEASE_MANIFEST_BYTES;
  const maxSignatureBytes = options.maxSignatureBytes ?? DEFAULT_MAX_RELEASE_SIGNATURE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Release manifest size limit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxSignatureBytes) || maxSignatureBytes < 1) {
    throw new Error("Release manifest signature size limit must be a positive safe integer");
  }
  const attempts = options.attempts ?? DEFAULT_RELEASE_MANIFEST_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RELEASE_MANIFEST_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("Release manifest attempts must be an integer from 1 to 10");
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30_000) {
    throw new Error("Release manifest retry delay must be an integer from 0 to 30000");
  }

  const trustedKeys = options.trustedKeys ?? embeddedReleaseTrustKeys();
  if (trustedKeys.length === 0) throw new Error("release_signature_trust_root_unconfigured");

  const common = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    attempts,
    retryDelayMs
  };
  const manifestBytes = await fetchBoundedHttpsBytes(parsedUrl, {
    ...common,
    maxBytes,
    label: "Release manifest"
  });
  const signatureBytes = await fetchBoundedHttpsBytes(releaseManifestSignatureUrl(parsedUrl), {
    ...common,
    maxBytes: maxSignatureBytes,
    label: "Release manifest signature"
  });

  let signatureDocument: unknown;
  try {
    signatureDocument = JSON.parse(
      decodeUtf8(signatureBytes, "Release manifest signature")
    ) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Release manifest signature response is invalid JSON");
    }
    throw error;
  }
  const signature = parseReleaseSignatureEnvelope(signatureDocument);
  verifyReleaseManifestSignature(manifestBytes, signature, trustedKeys);

  let document: unknown;
  try {
    document = JSON.parse(decodeUtf8(manifestBytes, "Release manifest")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Release manifest response is invalid JSON");
    throw error;
  }
  return parseReleaseManifest(document);
}
