/**
 * HTTP Body Utilities — bounded parsing for untrusted request bodies.
 * Wing: shared | Topic: http-input-boundary | Updated: 2026-08-26
 *
 * Provenance: SECURITY input-validation and size-limit requirements.
 */

import type { IncomingMessage } from "node:http";

export class PayloadTooLargeError extends Error {}
export class UnsupportedMediaTypeError extends Error {}

export async function readBoundedBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maxBodyBytes) {
      throw new PayloadTooLargeError("Request body exceeds configured limit");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function readBoundedJson(
  req: IncomingMessage,
  maxBodyBytes: number
): Promise<unknown> {
  const mediaType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new UnsupportedMediaTypeError("Content-Type must be application/json");
  }
  const body = await readBoundedBody(req, maxBodyBytes);
  return body.length === 0 ? undefined : JSON.parse(body);
}

export async function readBoundedForm(
  req: IncomingMessage,
  maxBodyBytes: number
): Promise<URLSearchParams> {
  const mediaType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") {
    throw new UnsupportedMediaTypeError("Content-Type must be application/x-www-form-urlencoded");
  }
  return new URLSearchParams(await readBoundedBody(req, maxBodyBytes));
}
