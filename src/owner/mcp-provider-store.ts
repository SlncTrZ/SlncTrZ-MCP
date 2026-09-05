/**
 * Managed MCP Provider Store — durable non-secret provider configuration.
 * Credentials are referenced by opaque names only and live behind a separate secret boundary.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as z from "zod/v4";
import {
  compileExtensionManifest,
  MAX_EXTENSIONS,
  type ExtensionManifestV1
} from "../extension/manifest.js";

export interface ManagedMcpProvider {
  readonly id: string;
  readonly name?: string;
  readonly enabled: boolean;
  readonly manifest: ExtensionManifestV1;
  readonly updatedAt: string;
}

export interface McpProviderStore {
  list(): Promise<readonly ManagedMcpProvider[]>;
  get(providerId: string): Promise<ManagedMcpProvider | undefined>;
  upsert(input: {
    readonly manifest: ExtensionManifestV1;
    readonly name?: string;
    readonly enabled?: boolean;
  }): Promise<ManagedMcpProvider>;
  remove(providerId: string): Promise<boolean>;
}

const storedProviderSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    enabled: z.boolean(),
    manifest: z.unknown(),
    updatedAt: z.iso.datetime()
  })
  .strict();

const mutationQueues = new Map<string, Promise<void>>();

async function withFileMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const prior = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = prior.catch(() => undefined).then(() => gate);
  mutationQueues.set(key, tail);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(key) === tail) {
      void tail.finally(() => {
        if (mutationQueues.get(key) === tail) mutationQueues.delete(key);
      });
    }
  }
}

const storeSchema = z
  .object({
    schemaVersion: z.literal(1),
    providers: z.array(storedProviderSchema).max(MAX_EXTENSIONS)
  })
  .strict();

function cloneProvider(provider: ManagedMcpProvider): ManagedMcpProvider {
  return Object.freeze({
    id: provider.id,
    ...(provider.name === undefined ? {} : { name: provider.name }),
    enabled: provider.enabled,
    manifest: structuredClone(provider.manifest),
    updatedAt: provider.updatedAt
  });
}

async function validateProvider(
  raw: z.infer<typeof storedProviderSchema>
): Promise<ManagedMcpProvider> {
  const manifest = raw.manifest as ExtensionManifestV1;
  const compiled = await compileExtensionManifest(manifest);
  if (compiled.tools.length === 0) throw new Error("mcp_provider_tools_required");
  return cloneProvider({
    id: compiled.id,
    ...(raw.name === undefined ? {} : { name: raw.name }),
    enabled: raw.enabled,
    manifest,
    updatedAt: raw.updatedAt
  });
}

async function loadFile(path: string): Promise<ManagedMcpProvider[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("mcp_provider_store_invalid_json");
  }
  const envelope = storeSchema.safeParse(parsed);
  if (!envelope.success) throw new Error("mcp_provider_store_invalid_schema");

  const providers: ManagedMcpProvider[] = [];
  const seen = new Set<string>();
  for (const record of envelope.data.providers) {
    const provider = await validateProvider(record);
    if (seen.has(provider.id)) throw new Error("mcp_provider_store_duplicate_provider");
    seen.add(provider.id);
    providers.push(provider);
  }
  return providers.sort((left, right) => left.id.localeCompare(right.id));
}

async function atomicWrite(path: string, providers: readonly ManagedMcpProvider[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  const body = `${JSON.stringify(
    {
      schemaVersion: 1,
      providers: providers.map((provider) => ({
        ...(provider.name === undefined ? {} : { name: provider.name }),
        enabled: provider.enabled,
        manifest: provider.manifest,
        updatedAt: provider.updatedAt
      }))
    },
    null,
    2
  )}\n`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function createMcpProviderStore(providerFile: string): McpProviderStore {
  return Object.freeze({
    async list() {
      return Object.freeze((await loadFile(providerFile)).map(cloneProvider));
    },
    async get(providerId: string) {
      const provider = (await loadFile(providerFile)).find((entry) => entry.id === providerId);
      return provider === undefined ? undefined : cloneProvider(provider);
    },
    async upsert(input: {
      readonly manifest: ExtensionManifestV1;
      readonly name?: string;
      readonly enabled?: boolean;
    }) {
      const compiled = await compileExtensionManifest(input.manifest);
      if (compiled.tools.length === 0) throw new Error("mcp_provider_tools_required");
      if (input.name !== undefined && (input.name.length === 0 || input.name.length > 128)) {
        throw new Error("mcp_provider_name_invalid");
      }
      return withFileMutation(providerFile, async () => {
        const providers = await loadFile(providerFile);
        const existing = providers.find((provider) => provider.id === compiled.id);
        const provider = cloneProvider({
          id: compiled.id,
          ...(input.name === undefined
            ? existing?.name === undefined
              ? {}
              : { name: existing.name }
            : { name: input.name }),
          enabled: input.enabled ?? existing?.enabled ?? true,
          manifest: structuredClone(input.manifest),
          updatedAt: new Date().toISOString()
        });
        const next = providers.filter((entry) => entry.id !== provider.id);
        next.push(provider);
        if (next.length > MAX_EXTENSIONS) throw new Error("mcp_provider_store_capacity_exceeded");
        next.sort((left, right) => left.id.localeCompare(right.id));
        await atomicWrite(providerFile, next);
        return provider;
      });
    },
    async remove(providerId: string) {
      return withFileMutation(providerFile, async () => {
        const providers = await loadFile(providerFile);
        const next = providers.filter((provider) => provider.id !== providerId);
        if (next.length === providers.length) return false;
        await atomicWrite(providerFile, next);
        return true;
      });
    }
  });
}
