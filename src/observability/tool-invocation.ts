/**
 * Central tool-invocation instrumentation.
 *
 * The wrapper inspects only the stable result envelope. It never reads arguments, content,
 * paths, client/workspace identifiers, or provider metadata.
 */

import type { MetricsRegistry } from "./metrics.js";

function resultFlags(result: unknown): { readonly error: boolean; readonly truncated: boolean } {
  if (typeof result !== "object" || result === null) return { error: false, truncated: false };
  const record = result as Readonly<Record<string, unknown>>;
  const structured =
    typeof record.structuredContent === "object" && record.structuredContent !== null
      ? (record.structuredContent as Readonly<Record<string, unknown>>)
      : undefined;
  return {
    error: record.isError === true,
    truncated: structured?.truncated === true
  };
}

export async function observeToolInvocation<T>(
  metrics: MetricsRegistry | undefined,
  work: () => Promise<T>
): Promise<T> {
  if (metrics === undefined) return work();

  const startedAt = performance.now();
  metrics.toolStarted();
  let error = true;
  let truncated = false;
  try {
    const result = await work();
    const flags = resultFlags(result);
    error = flags.error;
    truncated = flags.truncated;
    return result;
  } finally {
    metrics.toolFinished({
      error,
      truncated,
      durationMs: Math.max(0, performance.now() - startedAt)
    });
  }
}
