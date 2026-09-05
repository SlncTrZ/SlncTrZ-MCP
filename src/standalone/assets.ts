/** Access text resources embedded in the standalone SEA without repository-local filesystem paths. */

import { getAsset, isSea } from "node:sea";

export function isStandaloneSeaRuntime(): boolean {
  return isSea();
}

export function readStandaloneTextAsset(key: string): string | undefined {
  if (!isSea()) return undefined;
  try {
    return getAsset(key, "utf8");
  } catch {
    return undefined;
  }
}
