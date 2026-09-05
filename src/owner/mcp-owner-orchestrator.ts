/**
 * MCP Owner Orchestrator — composite multi-store provider management with rollback semantics.
 * Wing: owner | Topic: mcp-orchestrator | Updated: 2026-08-30
 *
 * A single intent may span the credential store, provider store, policy mutation and runtime
 * reload. Browser code must not stitch those mutations together; it calls one intent here and
 * receives a deterministic committed / rolled_back / partial_failure summary instead. Secrets
 * are only ever passed to the credential store; no key material is returned or logged.
 */

import type { ProviderCredential } from "../extension/adapter.js";
import type { ExtensionManifestV1, ExtensionToolSchemaRecord } from "../extension/manifest.js";
import { discoverRiskClass } from "./mcp-presentation.js";
import type { McpCredentialStore } from "./mcp-credential-store.js";
import type { McpProviderService } from "./mcp-provider-service.js";

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
    async add(input: AddMcpProviderIntent): Promise<McpCompositeResult> {
      const providerId = input.manifest.id;
      const completed: string[] = [];
      let credentialRef: string | undefined;
      let currentStep = "provider_probed";
      try {
        if (input.auth !== undefined) {
          credentialRef = `${providerId}-credential`;
          currentStep = "credential_saved";
          await options.credentials.set(credentialRef, toCredential(input.auth));
          completed.push("credential_saved");
        }

        currentStep = "provider_probed";
        const discovery = await options.providers.discoverCandidate({
          ...input.manifest,
          ...(credentialRef === undefined ? {} : { credentialRefs: [credentialRef] })
        });
        if (discovery.discoveredTools.length === 0) throw new Error("mcp_no_tools_discovered");
        const tools: ExtensionToolSchemaRecord[] = discovery.discoveredTools.map((canonicalId) => ({
          canonicalId,
          riskClass: discoverRiskClass(input.manifest.transport),
          ...(discovery.discoveredDescriptions?.[canonicalId] === undefined
            ? {}
            : { description: discovery.discoveredDescriptions[canonicalId] })
        }));

        currentStep = "provider_saved";
        const saved = await options.providers.addOrUpdate({
          manifest: {
            ...input.manifest,
            tools,
            ...(credentialRef === undefined ? {} : { credentialRefs: [credentialRef] })
          },
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled })
        });
        if (!saved.reload.activated) throw new Error("mcp_provider_activation_failed");
        completed.push("provider_saved");

        return { status: "committed", providerId, completedSteps: completed };
      } catch {
        const failedStep = currentStep;
        try {
          if (completed.includes("provider_saved")) {
            await options.providers.remove(providerId);
          }
          if (completed.includes("credential_saved") && credentialRef !== undefined) {
            await options.credentials.remove(credentialRef);
          }
          return {
            status: "rolled_back",
            providerId,
            completedSteps: completed,
            failedStep,
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
    },

    async updateAuth(input: {
      readonly providerId: string;
      readonly auth: McpOwnerCredentialIntent;
    }): Promise<McpCompositeResult> {
      const provider = (await options.providers.list()).find(
        (entry) => entry.id === input.providerId
      );
      if (provider === undefined) {
        return activeFail(input.providerId, [], "provider_lookup", "verify_provider", true);
      }
      const ref = provider.manifest.credentialRefs?.[0];
      if (ref === undefined) {
        return activeFail(input.providerId, [], "credential_set", "add_credential_ref", false);
      }
      const completed: string[] = [];
      try {
        await options.credentials.set(ref, toCredential(input.auth));
        completed.push("credential_saved");
        await options.providers.discover(input.providerId);
        completed.push("provider_probed");
        return { status: "committed", providerId: input.providerId, completedSteps: completed };
      } catch (error) {
        const failedStep = completed.includes("provider_probed")
          ? "provider_probe"
          : "provider_probe";
        // We replaced the credential but never read the old value, so it cannot be restored.
        return {
          status: "partial_failure",
          providerId: input.providerId,
          completedSteps: completed,
          failedStep: stepFor(error) === "provider_unavailable" ? failedStep : "credential_set",
          recovery: { action: "reconfigure_authentication", safeToRetry: true }
        };
      }
    },

    async sync(input: { readonly providerId: string }): Promise<McpCompositeResult> {
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
        return activeFail(input.providerId, [], stepFor(error), "retry_sync", true);
      }
    },

    async remove(input: { readonly providerId: string }): Promise<McpCompositeResult> {
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
          recovery: { action: "retry_remove", safeToRetry: true }
        };
      }
    }
  });
}
