/**
 * Validated HTTPS fetch with bounded manual redirect handling for release distribution.
 */

export const DEFAULT_MAX_HTTPS_REDIRECTS = 5;

export function validateHttpsUrl(value: string | URL, label = "URL"): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${label} must not include userinfo`);
  }
  return url;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { readonly name?: unknown }).name === "AbortError";
}

export function isTransientFetchError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const record = current as { readonly code?: unknown; readonly cause?: unknown };
    if (typeof record.code === "string" && TRANSIENT_NETWORK_CODES.has(record.code)) return true;
    if (current instanceof TypeError) return true;
    current = record.cause;
  }
  return false;
}

export async function waitForNetworkRetry(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (baseDelayMs === 0) return;
  const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
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

export async function fetchHttpsWithRedirects(
  input: string | URL,
  options: {
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly maxRedirects?: number;
    readonly label?: string;
  } = {}
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const label = options.label ?? "URL";
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_HTTPS_REDIRECTS;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new Error("HTTPS redirect limit must be an integer between 0 and 20");
  }

  let current = validateHttpsUrl(input, label);
  const visited = new Set<string>();

  for (let redirects = 0; ; redirects += 1) {
    if (visited.has(current.href)) throw new Error(`${label} redirect loop detected`);
    visited.add(current.href);

    const response = await fetchImpl(current, {
      redirect: "manual",
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    if (!isRedirectStatus(response.status)) return response;
    if (redirects >= maxRedirects) throw new Error(`${label} exceeded redirect limit`);

    const location = response.headers.get("location");
    if (location === null || location.length === 0) {
      throw new Error(`${label} redirect is missing Location`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`${label} redirect Location is invalid`);
    }
    current = validateHttpsUrl(next, `${label} redirect target`);
  }
}
