/** Direct managed Paths mutation with atomic persistence + active snapshot reload. */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  compilePolicyDocument,
  loadPolicyDocument,
  type PolicyDocument
} from "../policy/policy-config.js";
import type { PolicySnapshotStore, ReloadResult } from "../policy/policy-store.js";

export type OwnerPolicyOperation =
  | { readonly kind: "add-path"; readonly path: string }
  | { readonly kind: "remove-path"; readonly path: string }
  | { readonly kind: "set-authority-mode"; readonly authorityMode: "restricted" | "autonomous" }
  | { readonly kind: "rollback-policy" };

export interface PolicyMutationService {
  apply(operation: OwnerPolicyOperation): Promise<ReloadResult>;
  validate(): Promise<{ readonly valid: true; readonly pathCount: number }>;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function mutatePolicy(
  document: PolicyDocument,
  operation: Exclude<OwnerPolicyOperation, { kind: "rollback-policy" }>
): PolicyDocument {
  if (operation.kind === "set-authority-mode") {
    return {
      schemaVersion: 2,
      paths: [...document.paths],
      authorityMode: operation.authorityMode
    };
  }
  if (!isAbsolute(operation.path)) throw new Error("path_must_be_absolute");
  const paths = [...document.paths];
  if (operation.kind === "add-path") {
    if (!paths.includes(operation.path)) paths.push(operation.path);
  } else {
    const index = paths.indexOf(operation.path);
    if (index >= 0) paths.splice(index, 1);
    if (paths.length === 0) throw new Error("at_least_one_path_required");
  }
  return {
    schemaVersion: 2,
    paths,
    ...(document.authorityMode === undefined ? {} : { authorityMode: document.authorityMode })
  };
}

export function createPolicyMutationService(options: {
  readonly policyFile: string;
  readonly policyStore: Pick<PolicySnapshotStore, "reload">;
}): PolicyMutationService {
  if (!isAbsolute(options.policyFile)) throw new Error("Owner policy file must be absolute");
  const rollbackFile = `${options.policyFile}.previous`;
  return Object.freeze({
    async validate() {
      const document = await loadPolicyDocument(options.policyFile);
      await compilePolicyDocument(document);
      return { valid: true as const, pathCount: document.paths.length };
    },
    async apply(operation: OwnerPolicyOperation) {
      const priorRaw = await readFile(options.policyFile, "utf8");
      if (operation.kind === "rollback-policy") {
        const rollbackRaw = await readFile(rollbackFile, "utf8").catch(() => undefined);
        if (rollbackRaw === undefined) throw new Error("policy_rollback_unavailable");
        await atomicWrite(options.policyFile, rollbackRaw);
        const result = await options.policyStore.reload();
        if (result.activated) await atomicWrite(rollbackFile, priorRaw);
        else await atomicWrite(options.policyFile, priorRaw);
        return result;
      }
      const prior = await loadPolicyDocument(options.policyFile);
      const candidate = mutatePolicy(prior, operation);
      await compilePolicyDocument(candidate);
      await atomicWrite(options.policyFile, `${JSON.stringify(candidate, null, 2)}\n`);
      try {
        const result = await options.policyStore.reload();
        if (result.activated) {
          await atomicWrite(rollbackFile, priorRaw);
          return result;
        }
        await atomicWrite(options.policyFile, priorRaw);
        return result;
      } catch (error) {
        await atomicWrite(options.policyFile, priorRaw);
        throw error;
      }
    }
  });
}
