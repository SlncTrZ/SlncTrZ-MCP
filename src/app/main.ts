/**
 * Application Entry Point — starts the public MCP data plane.
 * Wing: app | Topic: process-entrypoint | Updated: 2026-08-27
 *
 * Provenance: PLAN Phases 1-3, ADR-012, ADR-015, and the Phase 4 handoff slice 3.
 *
 * The active policy is loaded from the operator-owned SLNCTRZ_POLICY_FILE. An absent file
 * compiles a deny-all snapshot; a configured but unreadable/invalid file fails startup.
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
import { readRuntimeConfig } from "./config.js";
import { createGatewayServer, listenGateway } from "./http-server.js";
import { createControlPlaneServer, listenControlPlane } from "../control-plane/server.js";

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

/** Load, parse, and compile one policy file into a frozen active snapshot. */
async function loadActivePolicy(policyFile: string): Promise<ActivePolicySnapshot> {
  const document = await loadPolicyDocument(policyFile);
  const compiled = await compilePolicyDocument(document);
  const runtime = await createExtensionRuntimeCatalog(compiled.extensionRegistry, metrics);
  return buildActivePolicySnapshot(compiled, runtime);
}

/** A deny-all snapshot: no workspaces means authenticated clients see core.ping only. */
async function denyAllPolicy(): Promise<ActivePolicySnapshot> {
  return buildActivePolicySnapshot(
    await compilePolicyDocument({ schemaVersion: 1, workspaces: [] })
  );
}

const policyAudit: PolicyAuditSink = createJournalPolicyAuditSink(
  auditJournal,
  createJsonLinePolicyAuditSink(),
  metrics
);

const policyFile = config.policyFile;
const loader: PolicySnapshotLoader =
  policyFile === undefined ? denyAllPolicy : () => loadActivePolicy(policyFile);
// Startup validates the configured file eagerly; an invalid file fails the process.
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
  onError: (error) => {
    console.error(error.message);
  }
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
  address = await listenGateway(server, {
    host: config.host,
    port: config.port
  });
} catch (error) {
  await new Promise<void>((resolve) => controlServer.close(() => resolve()));
  throw error;
}

console.log(`SlncTrZ-MCP listening on http://${address.host}:${address.port}/mcp`);
console.log(
  `SlncTrZ-MCP control plane listening on http://${controlAddress.host}:${controlAddress.port}`
);
