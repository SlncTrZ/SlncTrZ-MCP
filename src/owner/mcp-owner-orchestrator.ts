/**
 * MCP Owner Orchestrator — composite multi-store provider management with rollback semantics.
 * Wing: owner | Topic: mcp-orchestrator | Updated: 2026-08-30
 *
 * A single intent may span the credential store, provider store, policy mutation and runtime
 * reload. Browser code must not stitch those mutations together; it calls one intent here and
 * receives a deterministic committed / rolled_back / partial_failure summary instead. Secrets
 * are only ever passed to the credential store; no key material is returned or logged.
 */

import { randomBytes } from "node:crypto";
import type { ProviderCredential } from "../extension/adapter.js";
import type { ExtensionManifestV1, ExtensionToolSchemaRecord } from "../extension/manifest.js";
import { discoverRiskClass } from "./mcp-presentation.js";
import type { McpCredentialStore } from "./mcp-credential-store.js";
import { McpProviderMutationError, type McpProviderService } from "./mcp-provider-service.js";

export type McpCompositeStatus = "committed" | "rolled_back" | "partial_failure";

export interface McpCompositeResult {
  readonly status: McpCompositeStatus;
  readonly providerId?: string;
  readonly completedSteps: readonly string[];
  readonly failedStep?: string;
  readonly recovery?: { readonly action: string; readonly safeToRetry: boolean };
}

export interface McpOwnerCredentialIntent {
  readonly kind: "bearer" | "http-header" | "env";
  readonly name?: string;
  readonly value: string;
}

export interface AddMcpProviderIntent {
  readonly manifest: ExtensionManifestV1;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly auth?: McpOwnerCredentialIntent;
}

export interface McpOwnerOrchestrator {
  add(input: AddMcpProviderIntent): Promise<McpCompositeResult>;
  updateAuth(input: {
    readonly providerId: string;
    readonly auth: McpOwnerCredentialIntent;
  }): Promise<McpCompositeResult>;
  sync(input: { readonly providerId: string }): Promise<McpCompositeResult>;
  remove(input: { readonly providerId: string }): Promise<McpCompositeResult>;
}

function toCredential(auth: McpOwnerCredentialIntent): ProviderCredential {
  if (auth.kind === "bearer") return { kind: "bearer", value: auth.value };
  if (auth.kind === "http-header") {
    if (auth.name === undefined || auth.name.length === 0)
      throw new Error("mcp_credential_name_invalid");
    return { kind: "http-header", name: auth.name, value: auth.value };
  }
  if (auth.name === undefined || auth.name.length === 0)
    throw new Error("mcp_credential_name_invalid");
  return { kind: "env", name: auth.name, value: auth.value };
}

/** Map a thrown error to a deterministic non-leaky recovery step label. */
function stagedCredentialRef(providerId: string): string {
  const suffix = randomBytes(8).toString("hex");
  const marker = "-cred-";
  const maxBaseLength = 64 - marker.length - suffix.length;
  return `${providerId.slice(0, maxBaseLength)}${marker}${suffix}`;
}

function stepFor(error: unknown): string {
  // SAFETY: `error` is an Error; we read only an optional `code` property (never the message
  // text), so a non-Error / adversarial value cannot leak command paths, endpoints, or secrets.
  const code = error instanceof Error ? (error as unknown as { code?: unknown }).code : undefined;
  if (typeof code === "string") return code;
  return "orchestration_failed";
}

export function createMcpOwnerOrchestrator(options: {
  readonly credentials: Pick<McpCredentialStore, "set" | "remove">;
  readonly providers: McpProviderService;
}): McpOwnerOrchestrator {
  let mutationTail: Promise<void> = Promise.resolve();
  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = mutationTail.catch(() => undefined).then(operation);
    mutationTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const cleanupUnreferencedCredentials = async (refs: readonly string[]): Promise<void> => {
    if (refs.length === 0) return;
    const providers = await options.providers.list();
    const referenced = new Set(
      providers.flatMap((provider) => [...(provider.manifest.credentialRefs ?? [])])
    );
    for (const ref of new Set(refs)) {
      if (!referenced.has(ref)) await options.credentials.remove(ref);
    }
  };

  const isIncompleteProviderRollback = (error: unknown): error is McpProviderMutationError =>
    error instanceof McpProviderMutationError && !error.rollbackComplete;

  const activeFail = (
    providerId: string,
    completed: readonly string[],
    failedStep: string,
    action: string,
    safeToRetry: boolean
  ): McpCompositeResult => ({
    status: "rolled_back",
    providerId,
    completedSteps: completed,
    failedStep,
    recovery: { action, safeToRetry }
  });

  return Object.freeze({
    add(input: AddMcpProviderIntent): Promise<McpCompositeResult> {
      return serializeMutation(async () => {
        const providerId = input.manifest.id;
        const priorProvider = (await options.providers.list()).find(
          (entry) => entry.id === providerId
        );
        const priorRefs = [...(priorProvider?.manifest.credentialRefs ?? [])];
        const completed: string[] = [];
        let stagedRef: string | undefined;
        let currentStep = "provider_probed";
        let activated = false;
        try {
          if (input.auth !== undefined) {
            stagedRef = stagedCredentialRef(providerId);
            currentStep = "credential_saved";
            await options.credentials.set(stagedRef, toCredential(input.auth));
            completed.push("credential_saved");
          }

          const candidateManifest: ExtensionManifestV1 = {
            ...input.manifest,
            ...(stagedRef === undefined ? {} : { credentialRefs: [stagedRef] })
          };
          currentStep = "provider_probed";
          const discovery = await options.providers.discoverCandidate(candidateManifest);
          if (discovery.discoveredTools.length === 0) throw new Error("mcp_no_tools_discovered");
          completed.push("provider_probed");
          const tools: ExtensionToolSchemaRecord[] = discovery.discoveredTools.map(
            (canonicalId) => ({
              canonicalId,
              riskClass: discoverRiskClass(input.manifest.transport),
              ...(discovery.discoveredDescriptions?.[canonicalId] === undefined
                ? {}
                : { description: discovery.discoveredDescriptions[canonicalId] })
            })
          );

          currentStep = "provider_saved";
          const saved = await options.providers.addOrUpdate({
            manifest: { ...candidateManifest, tools },
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled })
          });
          if (!saved.reload.activated) throw new Error("mcp_provider_activation_failed");
          activated = true;
          completed.push("provider_saved");

          try {
            await cleanupUnreferencedCredentials(priorRefs);
          } catch {
            return {
              status: "partial_failure",
              providerId,
              completedSteps: completed,
              failedStep: "credential_cleanup",
              recovery: { action: "cleanup_old_credential", safeToRetry: true }
            };
          }
          return { status: "committed", providerId, completedSteps: completed };
        } catch (error) {
          const failedStep = currentStep;
          if (activated || isIncompleteProviderRollback(error)) {
            return {
              status: "partial_failure",
              providerId,
              completedSteps: completed,
              failedStep: isIncompleteProviderRollback(error) ? error.code : failedStep,
              recovery: { action: "repair_provider_state", safeToRetry: false }
            };
          }
          try {
            if (stagedRef !== undefined) await options.credentials.remove(stagedRef);
            return {
              status: "rolled_back",
              providerId,
              completedSteps: completed,
              failedStep: error instanceof McpProviderMutationError ? error.code : failedStep,
              recovery: { action: "retry_add", safeToRetry: true }
            };
          } catch {
            return {
              status: "partial_failure",
              providerId,
              completedSteps: completed,
              failedStep,
              recovery: { action: "manual_cleanup", safeToRetry: false }
            };
          }
        }
      });
    },

    updateAuth(input: {
      readonly providerId: string;
      readonly auth: McpOwnerCredentialIntent;
    }): Promise<McpCompositeResult> {
      return serializeMutation(async () => {
        const provider = (await options.providers.list()).find(
          (entry) => entry.id === input.providerId
        );
        if (provider === undefined) {
          return activeFail(input.providerId, [], "provider_lookup", "verify_provider", true);
        }
        const priorRefs = [...(provider.manifest.credentialRefs ?? [])];
        const priorRef = priorRefs[0];
        if (priorRef === undefined) {
          return activeFail(input.providerId, [], "credential_set", "add_credential_ref", false);
        }

        const stagedRef = stagedCredentialRef(input.providerId);
        const candidateRefs = priorRefs.map((ref, index) => (index === 0 ? stagedRef : ref));
        const candidateManifest: ExtensionManifestV1 = {
          ...provider.manifest,
          credentialRefs: candidateRefs
        };
        const completed: string[] = [];
        let currentStep = "credential_saved";
        try {
          await options.credentials.set(stagedRef, toCredential(input.auth));
          completed.push("credential_saved");

          currentStep = "provider_probed";
          await options.providers.discoverCandidate(candidateManifest);
          completed.push("provider_probed");

          currentStep = "provider_saved";
          const saved = await options.providers.addOrUpdate({
            manifest: candidateManifest,
            ...(provider.name === undefined ? {} : { name: provider.name }),
            enabled: provider.enabled
          });
          if (!saved.reload.activated) throw new Error("mcp_provider_activation_failed");
          completed.push("provider_saved");

          try {
            await cleanupUnreferencedCredentials([priorRef]);
          } catch {
            return {
              status: "partial_failure",
              providerId: input.providerId,
              completedSteps: completed,
              failedStep: "credential_cleanup",
              recovery: { action: "cleanup_old_credential", safeToRetry: true }
            };
          }
          return {
            status: "committed",
            providerId: input.providerId,
            completedSteps: completed
          };
        } catch (error) {
          if (isIncompleteProviderRollback(error)) {
            return {
              status: "partial_failure",
              providerId: input.providerId,
              completedSteps: completed,
              failedStep: error.code,
              recovery: { action: "repair_provider_state", safeToRetry: false }
            };
          }
          try {
            await options.credentials.remove(stagedRef);
          } catch {
            return {
              status: "partial_failure",
              providerId: input.providerId,
              completedSteps: completed,
              failedStep: currentStep,
              recovery: { action: "manual_cleanup", safeToRetry: false }
            };
          }
          return {
            status: "rolled_back",
            providerId: input.providerId,
            completedSteps: completed,
            failedStep:
              error instanceof McpProviderMutationError
                ? error.code
                : stepFor(error) === "provider_unavailable"
                  ? "provider_probed"
                  : currentStep,
            recovery: { action: "retry_auth_update", safeToRetry: true }
          };
        }
      });
    },

    sync(input: { readonly providerId: string }): Promise<McpCompositeResult> {
      return serializeMutation(async () => {
        try {
          const result = await options.providers.syncToDiscovered(input.providerId);
          if (result.reload.activated) {
            return {
              status: "committed",
              providerId: input.providerId,
              completedSteps: ["provider_synced"]
            };
          }
          return activeFail(input.providerId, [], "provider_sync", "retry_sync", true);
        } catch (error) {
          if (isIncompleteProviderRollback(error)) {
            return {
              status: "partial_failure",
              providerId: input.providerId,
              completedSteps: [],
              failedStep: error.code,
              recovery: { action: "repair_provider_state", safeToRetry: false }
            };
          }
          return activeFail(input.providerId, [], stepFor(error), "retry_sync", true);
        }
      });
    },

    remove(input: { readonly providerId: string }): Promise<McpCompositeResult> {
      return serializeMutation(async () => {
        const completed: string[] = [];
        try {
          const result = await options.providers.remove(input.providerId);
          if (result.removed) {
            return {
              status: "committed",
              providerId: input.providerId,
              completedSteps: completed
            };
          }
          return activeFail(input.providerId, completed, "provider_removed", "retry_remove", true);
        } catch (error) {
          return {
            status: "partial_failure",
            providerId: input.providerId,
            completedSteps: completed,
            failedStep: stepFor(error),
            recovery: {
              action: isIncompleteProviderRollback(error)
                ? "repair_provider_state"
                : "retry_remove",
              safeToRetry: !isIncompleteProviderRollback(error)
            }
          };
        }
      });
    }
  });
}
