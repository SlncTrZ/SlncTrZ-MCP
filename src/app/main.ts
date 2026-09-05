/**
 * Application Bootstrap — composes and starts the public MCP data plane.
 * Wing: app | Topic: process-bootstrap | Updated: 2026-08-28
 *
 * Provenance: PLAN Phases 1-3, Phase 8, ADR-012, ADR-015, and ADR-008.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryServerEventBus } from "@modelcontextprotocol/server";
import { createDynamicClientFileStore } from "../auth/dynamic-client-store.js";
import { OAuthService } from "../auth/oauth-service.js";
import { resolveOwnerSecret } from "../auth/owner-secret-store.js";
import {
  createJsonLineAuthAuditSink,
  createJournalAuthAuditSink
} from "../observability/auth-audit.js";
import { createAuditJournal } from "../observability/audit-journal.js";
import { createMetricsRegistry } from "../observability/metrics.js";
import { createSqliteAuditSink } from "../observability/sqlite-audit.js";
import {
  createJsonLineToolAuditSink,
  createJournalToolAuditSink
} from "../observability/tool-audit.js";
import { createExtensionRuntimeCatalog } from "../extension/runtime.js";
import { compilePolicyDocument, loadPolicyDocument } from "../policy/policy-config.js";
import { buildActivePolicySnapshot, type ActivePolicySnapshot } from "../policy/policy-snapshot.js";
import { createPolicySnapshotStore, type PolicySnapshotLoader } from "../policy/policy-store.js";
import {
  createJsonLinePolicyAuditSink,
  createJournalPolicyAuditSink,
  type PolicyAuditSink
} from "../observability/policy-audit.js";
import { createControlPlaneServer, listenControlPlane } from "../control-plane/server.js";
import {
  ensureManagedStateLayout,
  ensureRuntimeWorkspacePolicy,
  loadCommandCatalogState,
  managedStatePaths,
  resolveApplicationRoot
} from "../owner/managed-state.js";
import { createPolicyMutationService } from "../owner/policy-mutation.js";
import { createMcpCredentialStore } from "../owner/mcp-credential-store.js";
import { createMcpProviderService } from "../owner/mcp-provider-service.js";
import { createMcpOwnerOrchestrator } from "../owner/mcp-owner-orchestrator.js";
import { createMcpProviderStore } from "../owner/mcp-provider-store.js";
import { createOwnerWebConsole } from "../owner/web-console.js";
import { extractCanonicalAgentHarness } from "../shared/agent-harness.js";
import { APP_VERSION, BUILD_COMMIT } from "../shared/build-info.js";
import { isStandaloneSeaRuntime, readStandaloneTextAsset } from "../standalone/assets.js";
import { createTaskRuntime } from "../task/runtime.js";
import { readRuntimeConfig, type RuntimeConfig } from "./config.js";
import { createGatewayServer, listenGateway } from "./http-server.js";

export interface BootstrapDependencies {
  readonly config?: RuntimeConfig;
  readonly listenControlPlane?: typeof listenControlPlane;
  readonly listenGateway?: typeof listenGateway;
}

/** Compose and start both listeners. Importing this module has no startup side effect. */
export async function bootstrap(dependencies: BootstrapDependencies = {}): Promise<void> {
  const config = dependencies.config ?? readRuntimeConfig();
  const startControlPlane = dependencies.listenControlPlane ?? listenControlPlane;
  const startGateway = dependencies.listenGateway ?? listenGateway;
  const statePaths = managedStatePaths(config.stateRoot);
  await ensureManagedStateLayout(statePaths);
  const sqliteAudit = createSqliteAuditSink(statePaths.auditDatabaseFile);
  const auditJournal = createAuditJournal({
    capacity: 1_000,
    persist: (event) => sqliteAudit.append(event),
    onPersistError: (error) =>
      console.error(`[audit-sqlite] ${error instanceof Error ? error.message : "persist failed"}`)
  });
  const ownerSecret = await resolveOwnerSecret({
    secretFile: statePaths.ownerPassphraseFile,
    ...(config.ownerSecretHash === undefined ? {} : { environmentHash: config.ownerSecretHash })
  });
  const ownerSecretHash = ownerSecret.ownerSecretHash;
  if (ownerSecret.source === "migrated") {
    // Env-hash-only state (no plaintext recovery file) was migrated to a fresh plaintext file.
    // This is a degraded/migration state surfaced loudly, never silently treated as normal.
    console.error(
      "[owner-secret] owner_secret_migrated_from_environment_hash: " +
        `generated a fresh recoverable Owner Passphrase at ${ownerSecret.recoveryFile ?? statePaths.ownerPassphraseFile}; ` +
        "the previous passphrase represented only by SLNCTRZ_OWNER_SECRET_HASH no longer authenticates."
    );
  }
  const mcpCredentialStore = createMcpCredentialStore(statePaths.mcpCredentialsDirectory);
  const mcpProviderStore = createMcpProviderStore(statePaths.mcpProvidersFile);
  // Product setup owns schema migration. Runtime may create a missing default only for
  // source/developer bootstrap; an existing legacy/corrupt policy fails closed without rewrite.
  if (config.policyFile === undefined) {
    await ensureRuntimeWorkspacePolicy({ paths: statePaths, root: resolveApplicationRoot() });
  }
  const metrics = config.telemetryEnabled ? createMetricsRegistry() : undefined;
  let issuer: URL;
  try {
    issuer = new URL(config.publicMcpUrl.origin);
  } catch {
    throw new Error("Invalid issuer URL");
  }
  const dynamicClientStore = createDynamicClientFileStore(
    join(statePaths.root, "oauth-clients.json"),
    config.maxDynamicClients
  );
  const oauthService = new OAuthService({
    issuer,
    resource: config.publicMcpUrl,
    ownerSecretHash,
    maxDynamicClients: config.maxDynamicClients,
    audit: createJournalAuthAuditSink(auditJournal, createJsonLineAuthAuditSink(), metrics),
    dynamicClientStore,
    ...(config.staticClient === undefined ? {} : { staticClient: config.staticClient })
  });
  const loadActivePolicy = async (policyFile: string): Promise<ActivePolicySnapshot> => {
    const document = await loadPolicyDocument(policyFile);
    const managedProviderRecords = await mcpProviderStore.list();
    const enabledManagedProviders = managedProviderRecords
      .filter((provider) => provider.enabled)
      .map((provider) => provider.manifest);
    const commandCatalogState = await loadCommandCatalogState(statePaths, resolveApplicationRoot());
    if (commandCatalogState.status !== "ready") {
      console.error(
        `[command-catalog] ${commandCatalogState.errorCode}: ${commandCatalogState.path}` +
          (commandCatalogState.status === "invalid" ? `: ${commandCatalogState.message}` : "")
      );
    }
    const compiled = await compilePolicyDocument(
      document,
      commandCatalogState.status === "ready" ? commandCatalogState.catalog : undefined,
      enabledManagedProviders
    );
    const runtime = await createExtensionRuntimeCatalog(
      compiled.extensionRegistry,
      metrics,
      (refs) => mcpCredentialStore.resolve(refs)
    );
    return buildActivePolicySnapshot(compiled, runtime);
  };
  const policyAudit: PolicyAuditSink = createJournalPolicyAuditSink(
    auditJournal,
    createJsonLinePolicyAuditSink(),
    metrics
  );
  const explicitPolicyFile = config.policyFile;
  const policyFile = explicitPolicyFile ?? statePaths.policyFile;
  const loader: PolicySnapshotLoader = async () => loadActivePolicy(policyFile);
  const initial = await loader();
  const mcpEventBus = new InMemoryServerEventBus((error) => console.error(error.message));
  const policyStore = createPolicySnapshotStore(loader, initial, {
    audit: policyAudit,
    onActivated: (previous, active) => {
      if (previous.toolCatalogFingerprint !== active.toolCatalogFingerprint) {
        mcpEventBus.publish({ kind: "tools_list_changed" });
      }
    }
  });
  policyAudit({
    timestamp: new Date().toISOString(),
    eventType: "policy_compile",
    actorKind: "startup",
    previousVersion: initial.version,
    candidateVersion: initial.version,
    activeVersion: initial.version,
    result: "activated",
    riskIncrease: false,
    workspaceCount: 1,
    bindingCount: 0,
    durationMs: 0
  });
  const policyMutation = createPolicyMutationService({ policyFile, policyStore });
  const mcpProviderService = createMcpProviderService({
    store: mcpProviderStore,
    policyStore,
    resolveCredentials: (refs) => mcpCredentialStore.resolve(refs)
  });
  const mcpOrchestrator = createMcpOwnerOrchestrator({
    credentials: mcpCredentialStore,
    providers: mcpProviderService
  });
  const ownerWeb = config.ownerWebEnabled
    ? createOwnerWebConsole({
        ownerSecretHash,
        policyStore,
        statePaths,
        mutation: policyMutation,
        mcpProviders: mcpProviderService,
        mcpCredentials: mcpCredentialStore,
        mcpOrchestrator,
        secureCookies: config.publicMcpUrl.protocol === "https:",
        productInfo: {
          version: APP_VERSION,
          buildCommit: BUILD_COMMIT,
          stateRoot: statePaths.root,
          ownerPassphraseFile: statePaths.ownerPassphraseFile
        }
      })
    : undefined;
  const standaloneRuntime = isStandaloneSeaRuntime();
  const standaloneModelGuide = standaloneRuntime
    ? readStandaloneTextAsset("docs/MODEL_GUIDE.md")
    : undefined;
  const applicationRoot = resolveApplicationRoot();
  const agentHarnessSource = standaloneRuntime
    ? readStandaloneTextAsset("AGENTS.md")
    : await readFile(join(applicationRoot, "AGENTS.md"), "utf8");
  if (agentHarnessSource === undefined) throw new Error("agent_harness_missing");
  const agentHarness = extractCanonicalAgentHarness(agentHarnessSource);
  const taskRuntime = createTaskRuntime();
  const server = createGatewayServer({
    oauthService,
    policyStore,
    ...(config.ownerWebEnabled ? { ownerConsoleUrl: `${config.publicMcpUrl.origin}/owner` } : {}),
    gatewayInfo: {
      version: APP_VERSION,
      buildCommit: BUILD_COMMIT,
      config: {
        policy: statePaths.policyFile,
        commands: statePaths.commandCatalogFile,
        providers: statePaths.mcpProvidersFile,
        audit: statePaths.auditDatabaseFile
      },
      docs: standaloneRuntime ? [] : ["AGENTS.md", "docs/MODEL_GUIDE.md", "MCP_SERVERS.md"],
      ...(standaloneModelGuide === undefined ? {} : { modelGuide: standaloneModelGuide }),
      agentHarness
    },
    ...(ownerWeb === undefined ? {} : { ownerWeb }),
    toolAudit: createJournalToolAuditSink(auditJournal, createJsonLineToolAuditSink()),
    ...(metrics === undefined ? {} : { metrics }),
    mcpEventBus,
    taskRuntime,
    allowedHostnames: config.allowedHostnames,
    allowedOriginHostnames: config.allowedOriginHostnames,
    onError: (error) => console.error(error.message)
  });
  const controlServer = createControlPlaneServer({
    ownerSecretHash,
    oauthService,
    policyStore,
    auditJournal,
    gatewayInfo: { version: APP_VERSION, buildCommit: BUILD_COMMIT },
    ...(metrics === undefined ? {} : { metrics }),
    onError: (error) => console.error(error.message)
  });
  const controlAddress = await startControlPlane(controlServer, {
    host: config.controlHost,
    port: config.controlPort
  });
  let address;
  try {
    address = await startGateway(server, { host: config.host, port: config.port });
  } catch (error) {
    await new Promise<void>((resolve) => controlServer.close(() => resolve()));
    throw error;
  }
  console.log(`SlncTrZ-MCP listening on http://${address.host}:${address.port}/mcp`);
  console.log(
    `SlncTrZ-MCP control plane listening on http://${controlAddress.host}:${controlAddress.port}`
  );
}
