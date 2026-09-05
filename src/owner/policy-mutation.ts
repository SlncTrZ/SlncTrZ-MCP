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

export class PolicyMutationRecoveryError extends Error {
  readonly code = "policy_recovery_failed";

  constructor(cause: unknown) {
    super("Policy mutation failed and prior durable state could not be fully restored", { cause });
    this.name = "PolicyMutationRecoveryError";
  }
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

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function restoreOptionalFile(path: string, content: string | undefined): Promise<void> {
  if (content === undefined) {
    await rm(path, { force: true });
    return;
  }
  await atomicWrite(path, content);
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
  let mutationTail: Promise<void> = Promise.resolve();
  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = mutationTail.catch(() => undefined).then(operation);
    mutationTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
  return Object.freeze({
    async validate() {
      const document = await loadPolicyDocument(options.policyFile);
      await compilePolicyDocument(document);
      return { valid: true as const, pathCount: document.paths.length };
    },
    apply(operation: OwnerPolicyOperation) {
      return serializeMutation(async () => {
        const priorRaw = await readFile(options.policyFile, "utf8");
        const previousRaw = await readOptionalFile(rollbackFile);
        let nextRaw: string;

        if (operation.kind === "rollback-policy") {
          if (previousRaw === undefined) throw new Error("policy_rollback_unavailable");
          nextRaw = previousRaw;
        } else {
          const prior = await loadPolicyDocument(options.policyFile);
          const candidate = mutatePolicy(prior, operation);
          await compilePolicyDocument(candidate);
          nextRaw = `${JSON.stringify(candidate, null, 2)}\n`;
        }

        // Commit the rollback generation before publishing or activating the candidate. If this
        // write fails, the active snapshot and policy file are still untouched.
        await atomicWrite(rollbackFile, priorRaw);

        const restorePriorState = async (): Promise<void> => {
          try {
            await atomicWrite(options.policyFile, priorRaw);
            await restoreOptionalFile(rollbackFile, previousRaw);
          } catch (error) {
            throw new PolicyMutationRecoveryError(error);
          }
        };

        try {
          await atomicWrite(options.policyFile, nextRaw);
        } catch (error) {
          await restorePriorState();
          throw error;
        }

        let result: ReloadResult;
        try {
          result = await options.policyStore.reload();
        } catch (error) {
          await restorePriorState();
          throw error;
        }
        if (result.activated) return result;
        await restorePriorState();
        return result;
      });
    }
  });
}
