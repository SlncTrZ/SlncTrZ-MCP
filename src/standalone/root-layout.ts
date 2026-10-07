import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export interface ManagedRootLayout {
  readonly installRoot: string;
  readonly stateRoot: string;
  readonly configRoot: string;
}

function containsPath(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalManagedRoot(path: string): Promise<string> {
  const normalized = resolve(path);
  const missingTail: string[] = [];
  let cursor = normalized;

  while (true) {
    let exists = false;
    try {
      await lstat(cursor);
      exists = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new Error("Managed root could not be resolved safely");
      }
    }

    if (exists) {
      try {
        const canonical = await realpath(cursor);
        return resolve(canonical, ...missingTail.reverse());
      } catch {
        throw new Error("Managed root could not be resolved safely");
      }
    }

    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("Managed root could not be resolved safely");
    missingTail.push(basename(cursor));
    cursor = parent;
  }
}

/** Managed product roots must be absolute, non-filesystem-root, and canonically disjoint. */
export async function assertManagedRootLayout(layout: ManagedRootLayout): Promise<void> {
  const rawEntries = Object.entries(layout) as [keyof ManagedRootLayout, string][];
  const entries = await Promise.all(
    rawEntries.map(async ([name, value]) => {
      const normalized = resolve(value);
      if (!isAbsolute(value) || normalized === parse(normalized).root) {
        throw new Error(`Managed ${name} is unsafe`);
      }
      const canonical = await canonicalManagedRoot(normalized);
      if (canonical === parse(canonical).root) throw new Error(`Managed ${name} is unsafe`);
      return [name, canonical] as const;
    })
  );

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      if (left === undefined || right === undefined) continue;
      if (containsPath(left[1], right[1]) || containsPath(right[1], left[1])) {
        throw new Error(`Managed roots must not overlap: ${left[0]} and ${right[0]}`);
      }
    }
  }
}
