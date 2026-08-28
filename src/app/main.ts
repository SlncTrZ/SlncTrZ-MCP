/**
 * Application Bootstrap — composes and starts the public MCP data plane.
 * Wing: app | Topic: process-bootstrap | Updated: 2026-08-28
 *
 * Provenance: PLAN Phases 1-3, Phase 8, ADR-012, ADR-015, and ADR-008.
 */

import { OAuthService } from "../auth/oauth-service.js";
import {
  createJsonLineAuthAuditSink,
  createJournalAuthAuditSink
} from "../observability/auth-audit.js";
import { createAuditJournal } from "../observability/audit-journal.js";
import { createMetricsRegistry } from "../observability/metrics.js";
import {
  createJsonLineToolAuditSink,
  createJournalToolAuditSink
} from "../observability/tool-audit.js";
import { createExtensionRuntimeCatalog } from "../extension/runtime.js";
import { compilePolicyDocument, loadPolicyDocument } from "../policy/policy-config.js";
import { buildActivePolicySnapshot, type ActivePolicySnapshot } from "../policy/policy-snapshot.js";
import { createPolicySnapshotStore, type PolicySnapshotLoader } from "../policy/policy-store.js";
import { defaultApprovalHook } from "../policy/approval.js";
import {
  createJsonLinePolicyAuditSink,
  createJournalPolicyAuditSink,
  type PolicyAuditSink
} from "../observability/policy-audit.js";
import { createControlPlaneServer, listenControlPlane } from "../control-plane/server.js";
import { readRuntimeConfig } from "./config.js";
import { createGatewayServer, listenGateway } from "./http-server.js";

/** Compose and start both listeners. Importing this module has no startup side effect. */
export async function bootstrap(): Promise<void> {
  const config = readRuntimeConfig();
  const auditJournal = createAuditJournal({ capacity: 1_000 });
  const metrics = config.telemetryEnabled ? createMetricsRegistry() : undefined;
  let issuer: URL;
  try {
    issuer = new URL(config.publicMcpUrl.origin);
  } catch {
    throw new Error("Invalid issuer URL");
  }
  const oauthService = new OAuthService({
    issuer,
    resource: config.publicMcpUrl,
    ownerSecretHash: config.ownerSecretHash,
    maxDynamicClients: config.maxDynamicClients,
    audit: createJournalAuthAuditSink(auditJournal, createJsonLineAuthAuditSink(), metrics),
    ...(config.staticClient === undefined ? {} : { staticClient: config.staticClient })
  });
  const loadActivePolicy = async (policyFile: string): Promise<ActivePolicySnapshot> => {
    const document = await loadPolicyDocument(policyFile);
    const compiled = await compilePolicyDocument(document);
    const runtime = await createExtensionRuntimeCatalog(compiled.extensionRegistry, metrics);
    return buildActivePolicySnapshot(compiled, runtime);
  };
  const denyAllPolicy = async (): Promise<ActivePolicySnapshot> =>
    buildActivePolicySnapshot(await compilePolicyDocument({ schemaVersion: 1, workspaces: [] }));
  const policyAudit: PolicyAuditSink = createJournalPolicyAuditSink(
    auditJournal,
    createJsonLinePolicyAuditSink(),
    metrics
  );
  const policyFile = config.policyFile;
  const loader: PolicySnapshotLoader =
    policyFile === undefined ? denyAllPolicy : () => loadActivePolicy(policyFile);
  const initial = await loader();
  const policyStore = createPolicySnapshotStore(loader, initial, {
    approval: defaultApprovalHook,
    audit: policyAudit
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
    workspaceCount: initial.normalized.workspaces.length,
    bindingCount: initial.normalized.clientBindings.length,
    durationMs: 0
  });
  const server = createGatewayServer({
    oauthService,
    policyStore,
    toolAudit: createJournalToolAuditSink(auditJournal, createJsonLineToolAuditSink()),
    ...(metrics === undefined ? {} : { metrics }),
    allowedHostnames: config.allowedHostnames,
    allowedOriginHostnames: config.allowedOriginHostnames,
    onError: (error) => console.error(error.message)
  });
  const controlServer = createControlPlaneServer({
    ownerSecretHash: config.ownerSecretHash,
    oauthService,
    policyStore,
    auditJournal,
    ...(metrics === undefined ? {} : { metrics }),
    onError: (error) => console.error(error.message)
  });
  const controlAddress = await listenControlPlane(controlServer, {
    host: config.controlHost,
    port: config.controlPort
  });
  let address;
  try {
    address = await listenGateway(server, { host: config.host, port: config.port });
  } catch (error) {
    await new Promise<void>((resolve) => controlServer.close(() => resolve()));
    throw error;
  }
  console.log(`SlncTrZ-MCP listening on http://${address.host}:${address.port}/mcp`);
  console.log(
    `SlncTrZ-MCP control plane listening on http://${controlAddress.host}:${controlAddress.port}`
  );
}
