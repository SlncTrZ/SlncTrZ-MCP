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
