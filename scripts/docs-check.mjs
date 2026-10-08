/** Public documentation contract checks that fail CI when user-facing commands drift. */

import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readVersion, RELEASE_LINE_MARKER } from "./version.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const [
  readme,
  release,
  provenance,
  pkgRaw,
  productHarness,
  modelGuide,
  deployment,
  troubleshooting,
  backup,
  architecture,
  autonomy,
  security,
  threatModel,
  releaseAcceptance,
  engineering,
  plan,
  operationalFiles,
  projectContextAdr,
  mcpServers
] = await Promise.all([
  readFile(join(root, "README.md"), "utf8"),
  readFile(join(root, "RELEASE.md"), "utf8"),
  readFile(join(root, "PROVENANCE.md"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
  readFile(join(root, "PRODUCT_AGENT_HARNESS.md"), "utf8"),
  readFile(join(root, "docs", "MODEL_GUIDE.md"), "utf8"),
  readFile(join(root, "docs", "DEPLOYMENT.md"), "utf8"),
  readFile(join(root, "docs", "TROUBLESHOOTING.md"), "utf8"),
  readFile(join(root, "docs", "BACKUP_RESTORE.md"), "utf8"),
  readFile(join(root, "ARCHITECTURE.md"), "utf8"),
  readFile(join(root, "docs", "AUTONOMY.md"), "utf8"),
  readFile(join(root, "SECURITY.md"), "utf8"),
  readFile(join(root, "docs", "THREAT_MODEL.md"), "utf8"),
  readFile(join(root, "docs", "RELEASE_ACCEPTANCE.md"), "utf8"),
  readFile(join(root, "ENGINEERING.md"), "utf8"),
  readFile(join(root, "PLAN.md"), "utf8"),
  readFile(join(root, "docs", "OPERATIONAL_FILES.md"), "utf8"),
  readFile(join(root, "docs", "adr", "adr-009-project-instructions-explicit-context.md"), "utf8"),
  readFile(join(root, "MCP_SERVERS.md"), "utf8")
]);
const pkg = JSON.parse(pkgRaw);
const directInventoryStart = provenance.indexOf("## Direct runtime dependency inventory");
const directInventoryEnd = provenance.indexOf("## Development/build dependency snapshot");
if (directInventoryStart < 0 || directInventoryEnd <= directInventoryStart) {
  throw new Error("docs_contract_failed: PROVENANCE direct dependency inventory section missing");
}
const directInventory = provenance.slice(directInventoryStart, directInventoryEnd);
const [userGuide, adrIndex, standaloneWorkflow, ciWorkflow, changelog, release035, adr008, adr020] =
  await Promise.all([
    readFile(join(root, "docs", "USER_GUIDE.md"), "utf8"),
    readFile(join(root, "docs", "adr", "README.md"), "utf8"),
    readFile(join(root, ".github", "workflows", "standalone.yml"), "utf8"),
    readFile(join(root, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(join(root, "CHANGELOG.md"), "utf8"),
    readFile(join(root, "docs", "releases", "v0.3.5.md"), "utf8"),
    readFile(
      join(root, "docs", "adr", "adr-008-standalone-packaging-runtime-separation.md"),
      "utf8"
    ),
    readFile(
      join(root, "docs", "adr", "adr-020-bounded-isolated-mcp-extension-transports.md"),
      "utf8"
    )
  ]);

function requireText(haystack, needle, label) {
  if (!haystack.replace(/\s+/gu, " ").includes(needle.replace(/\s+/gu, " "))) {
    throw new Error(`docs_contract_failed: ${label} missing ${JSON.stringify(needle)}`);
  }
}

function forbidText(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`docs_contract_failed: ${label} still contains ${JSON.stringify(needle)}`);
  }
}

for (const dependency of Object.keys(pkg.dependencies ?? {})) {
  requireText(directInventory, `\`${dependency}\``, "PROVENANCE direct dependency inventory");
}

for (const currentTool of ["core.read", "core.search", "core.write", "core.edit"]) {
  requireText(userGuide, currentTool, "USER_GUIDE");
}
for (const legacyTool of ["read_file", "write_file"]) {
  forbidText(userGuide, legacyTool, "USER_GUIDE");
}
requireText(adrIndex, "Superseded by ADR-027", "ADR index");
requireText(adrIndex, "ADR-027 | Global coding context", "ADR index");

for (const command of [
  "slnctrz-mcp status",
  "slnctrz-mcp doctor",
  "slnctrz-mcp config show",
  "slnctrz-mcp update",
  "slnctrz-mcp rollback",
  "slnctrz-mcp repair",
  "slnctrz-mcp uninstall --yes",
  "slnctrz-mcp owner rotate-passphrase"
]) {
  requireText(userGuide, command, "USER_GUIDE");
}

// README is the product entry point; operational details belong in the linked User Guide.
for (const value of [
  "http://127.0.0.1:3100/mcp",
  "releases/latest/download/install.sh",
  "docs/USER_GUIDE.md",
  "docs/GATEWAY_ONLY.md",
  "docs/README.md",
  ">=22.13.0 <25"
])
  requireText(readme, value, "README");
for (const value of [
  "http://127.0.0.1:3100/owner",
  "Windows x64 with Git Bash",
  "%USERPROFILE%\\.slnctrz-mcp"
])
  requireText(userGuide, value, "USER_GUIDE");

if (pkg.engines?.node !== ">=22.13.0 <25") {
  throw new Error(
    "docs_contract_failed: package Node engine changed; update docs-check and public docs"
  );
}
// Release line is derived from package.json through the single version module, so CI
// never needs to hardcode a line. readVersion() throws if the shape is unsupported.
const { releaseLine } = await readVersion();
const currentReleaseNotes = await readFile(
  join(root, "docs", "releases", `v${pkg.version}.md`),
  "utf8"
);
for (const value of [
  `# SlncTrZ-MCP v${pkg.version}`,
  "## User-visible changes",
  "## Security-relevant changes",
  "## Migration / restart / reauthorization",
  "## Supported / prebuilt targets",
  "## Known limitations",
  "## Rollback"
]) {
  requireText(currentReleaseNotes, value, "current release notes");
}

for (const value of [
  "manifest.json.sig",
  "SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64",
  "SLNCTRZ_RELEASE_SIGNING_PRIVATE_KEY_B64",
  "scripts/sign-release-file.mjs"
]) {
  requireText(standaloneWorkflow, value, "standalone release workflow");
}

const windowsCiStart = ciWorkflow.indexOf("\n  verify-windows:");
const provenanceCiStart = ciWorkflow.indexOf("\n  provenance:");
if (windowsCiStart < 0 || provenanceCiStart <= windowsCiStart) {
  throw new Error("docs_contract_failed: Windows CI gate block missing");
}
const windowsCiWorkflow = ciWorkflow.slice(windowsCiStart, provenanceCiStart);
for (const value of ["Build Windows x64 SEA", "SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64"]) {
  requireText(windowsCiWorkflow, value, "Windows CI SEA build");
}

const aggregateReleaseStart = standaloneWorkflow.indexOf("\n  aggregate-release:");
const publishCandidateStart = standaloneWorkflow.indexOf("\n  publish-candidate:");
if (aggregateReleaseStart < 0 || publishCandidateStart <= aggregateReleaseStart) {
  throw new Error("docs_contract_failed: aggregate-release workflow block missing");
}
const aggregateReleaseWorkflow = standaloneWorkflow.slice(
  aggregateReleaseStart,
  publishCandidateStart
);
for (const value of [
  "if: github.ref_type == 'tag' && startsWith(github.ref_name, 'v')",
  "environment:\n      name: release-signing",
  "fetch-depth: 0",
  'git merge-base --is-ancestor "${GITHUB_SHA}" "origin/main"',
  "SLNCTRZ_RELEASE_SIGNING_PRIVATE_KEY_B64"
]) {
  requireText(aggregateReleaseWorkflow, value, "aggregate-release signing boundary");
}

requireText(release, "manifest.json.sig", "RELEASE");
requireText(release, "protected GitHub Environment `release-signing`", "RELEASE");
requireText(release, "no repository-level or organization-level duplicate", "RELEASE");
requireText(release, "disposable Ed25519 verification key", "RELEASE");
requireText(userGuide, "Ed25519 trust root", "USER_GUIDE");
requireText(readme, `docs/releases/v${pkg.version}.md`, "README release link");
requireText(
  userGuide,
  "Release status is determined by the published GitHub release",
  "USER_GUIDE"
);
requireText(threatModel, "Ed25519 publisher signature", "THREAT_MODEL");
requireText(threatModel, "Release signing-key misuse", "THREAT_MODEL");
requireText(
  security,
  "Owner-secret abuse budgets count failed authentication attempts, not successful Owner logins/approvals",
  "SECURITY"
);
requireText(
  troubleshooting,
  "acknowledged OAuth grant/token-family state are durable",
  "TROUBLESHOOTING"
);
forbidText(
  troubleshooting,
  "access tokens, and refresh tokens are intentionally process-memory state",
  "TROUBLESHOOTING"
);
requireText(
  releaseAcceptance,
  "the `release-signing` Environment exists **before** the workflow run",
  "RELEASE_ACCEPTANCE"
);
forbidText(
  releaseAcceptance,
  "a successful recovery resets the incident restart budget",
  "RELEASE_ACCEPTANCE"
);
requireText(
  architecture,
  "recurrent `session_invalid` incidents are additionally bounded by a rolling incident budget",
  "ARCHITECTURE"
);
requireText(adrIndex, "Partially superseded by v0.3.6 signed release pipeline", "ADR index");
requireText(adrIndex, "Partially superseded by schema-v2/provider recovery contract", "ADR index");
requireText(adr008, "Current-contract note (2026-09-25)", "ADR-008");
requireText(adr008, "protected `release-signing` GitHub Environment", "ADR-008");
requireText(adr020, "rolling `provider_session_invalid` incident budget", "ADR-020");

const changelog036Start = changelog.indexOf(`\n## ${pkg.version}\n`);
const changelog035Start = changelog.indexOf("\n## 0.3.5\n");
const changelog034Start = changelog.indexOf("\n## 0.3.4\n");
if (
  changelog036Start < 0 ||
  changelog035Start <= changelog036Start ||
  changelog034Start <= changelog035Start
) {
  throw new Error("docs_contract_failed: changelog release boundaries missing");
}
const changelog036 = changelog.slice(changelog036Start, changelog035Start);
const changelog035 = changelog.slice(changelog035Start, changelog034Start);
for (const value of [
  "Wrong Owner Passphrase during browser OAuth",
  "Loopback control-plane Owner authentication",
  "MCP handler-construction failure releases",
  "Debate long-poll waiters share",
  "Publisher-authenticated update manifests"
]) {
  requireText(changelog036, value, "CHANGELOG current 0.3.6 release line");
}
for (const value of [
  "Wrong Owner Passphrase during browser OAuth",
  "Loopback control-plane Owner authentication",
  "MCP handler-construction failure",
  "manifest.json.sig",
  "Follow-up audit hardening"
]) {
  forbidText(changelog035, value, "CHANGELOG 0.3.5");
  forbidText(release035, value, "v0.3.5 release notes");
}
requireText(
  release035,
  "Post-tag audit/signing hardening belongs to the v0.3.6 release line",
  "v0.3.5 release notes"
);
requireText(
  currentReleaseNotes,
  "`audit.sqlite3` receives an additive migration",
  "current release notes"
);
requireText(currentReleaseNotes, "publisher signature", "current release notes");

// Drift guard: the public docs must not reference a different release line (X.Y.x).
function assertCurrentLineOnly(text, label) {
  for (const match of text.matchAll(RELEASE_LINE_MARKER)) {
    const otherLine = `${match[1]}.${match[2]}`;
    if (otherLine !== releaseLine) {
      throw new Error(
        `docs_contract_failed: ${label} references release line ${otherLine}.x; expected ${releaseLine}.x`
      );
    }
  }
}
for (const [text, label] of [
  [readme, "README"],
  [release, "RELEASE"],
  [provenance, "PROVENANCE"],
  [deployment, "DEPLOYMENT"],
  [troubleshooting, "TROUBLESHOOTING"]
]) {
  assertCurrentLineOnly(text, label);
}

for (const value of [
  "SLNCTRZ_CANONICAL_AGENT_HARNESS_BEGIN",
  "SLNCTRZ_CANONICAL_AGENT_HARNESS_END",
  "Simplicity first",
  "Surgical changes",
  "Read before you write",
  "Tests verify intent",
  "Checkpoint after every step",
  "Fail loud",
  "Reuse first",
  "No self-privilege"
]) {
  requireText(productHarness, value, "PRODUCT_AGENT_HARNESS");
}
requireText(
  modelGuide,
  "Owner-controlled access from Web AI to your Linux or Windows machine",
  "MODEL_GUIDE"
);
requireText(modelGuide, "structuredContent.modelGuide", "MODEL_GUIDE");
requireText(modelGuide, "structuredContent.agentHarness", "MODEL_GUIDE");
requireText(modelGuide, "core.ping", "MODEL_GUIDE");
requireText(modelGuide, "Restricted mode is a capability policy", "MODEL_GUIDE");
requireText(modelGuide, "task.start", "MODEL_GUIDE");
requireText(modelGuide, "task.create", "MODEL_GUIDE");
requireText(modelGuide, "in-memory only", "MODEL_GUIDE");
requireText(modelGuide, "structuredContent.managedTasks", "MODEL_GUIDE");
requireText(modelGuide, "True authorization/ownership denials", "MODEL_GUIDE");
requireText(userGuide, "## 6. Tasks and Debates", "USER_GUIDE");
requireText(userGuide, "task.start", "USER_GUIDE");
requireText(architecture, "task.create", "ARCHITECTURE");
requireText(architecture, "in-memory", "ARCHITECTURE");
requireText(architecture, "## Managed Task Runtime", "ARCHITECTURE");
requireText(architecture, "Product Agent Harness", "ARCHITECTURE");
requireText(architecture, "task.start", "ARCHITECTURE");
requireText(architecture, "Graceful application shutdown", "ARCHITECTURE");
requireText(architecture, "Credential rotation stages a new opaque ref", "ARCHITECTURE");
requireText(autonomy, "task.start", "AUTONOMY");
requireText(autonomy, "Logical coordination tools", "AUTONOMY");
requireText(security, "Task Runtime is not a second privilege path", "SECURITY");
requireText(security, "coordination-task text cannot grant capabilities", "SECURITY");
requireText(security, "Policy/provider/command authority mutation is transactional", "SECURITY");
requireText(security, "Graceful gateway shutdown", "SECURITY");
requireText(threatModel, "### Managed task requirements", "THREAT_MODEL");
requireText(threatModel, "Task-state exhaustion", "THREAT_MODEL");
requireText(threatModel, "Credential rotation rollback", "THREAT_MODEL");
requireText(releaseAcceptance, "Managed Task Runtime release acceptance", "RELEASE_ACCEPTANCE");
requireText(releaseAcceptance, "exactly one winner", "RELEASE_ACCEPTANCE");
requireText(releaseAcceptance, "OLD -> committed -> active runtime NEW", "RELEASE_ACCEPTANCE");
requireText(releaseAcceptance, "official legacy + modern-only", "RELEASE_ACCEPTANCE");
requireText(engineering, "`src/task`", "ENGINEERING");
requireText(engineering, "Public User Install target", "ENGINEERING");
requireText(plan, "canonical Product Agent Harness", "PLAN");
requireText(plan, "Task Coordinator multi-client claim", "PLAN");
requireText(
  operationalFiles,
  "Windows PowerShell 5.1 invocation compatibility",
  "OPERATIONAL_FILES"
);
requireText(deployment, "/opt/slnctrz-mcp", "DEPLOYMENT");
requireText(deployment, "Task Runtime lifecycle", "DEPLOYMENT");
requireText(deployment, "graceful SIGTERM/SIGINT shutdown", "DEPLOYMENT");
requireText(deployment, "/var/lib/slnctrz-mcp", "DEPLOYMENT");
requireText(deployment, "/etc/slnctrz-mcp", "DEPLOYMENT");
requireText(troubleshooting, "running_version_mismatch", "TROUBLESHOOTING");
requireText(troubleshooting, "Managed tasks after restart", "TROUBLESHOOTING");
requireText(backup, "secrets/owner-passphrase", "BACKUP_RESTORE");
requireText(backup, "Task Runtime state", "BACKUP_RESTORE");
requireText(projectContextAdr, "Superseded by ADR-027", "ADR-009");
requireText(projectContextAdr, "Product Agent Harness", "ADR-009");
requireText(mcpServers, "server/discover", "MCP_SERVERS");
requireText(mcpServers, "Credential rotation must activate the new credential", "MCP_SERVERS");

for (const [text, label] of [
  [userGuide, "USER_GUIDE"],
  [modelGuide, "MODEL_GUIDE"],
  [architecture, "ARCHITECTURE"],
  [releaseAcceptance, "RELEASE_ACCEPTANCE"]
]) {
  requireText(text, "context.bootstrap", label);
  requireText(text, "skills.read", label);
}
const harnessGuide = await readFile(join(root, "docs", "HARNESS.md"), "utf8");
const codingAgents = await readFile(join(root, "docs", "CODING_AGENTS.md"), "utf8");
for (const value of [
  "SLNCTRZ_HARNESS_ROOT",
  "slnctrzContext",
  "operationExecuted",
  "task.cancel",
  "four hours"
])
  requireText(harnessGuide, value, "HARNESS");
requireText(codingAgents, "org.slnctrz/contextToken", "CODING_AGENTS");
const gatewayOnly = await readFile(join(root, "docs", "GATEWAY_ONLY.md"), "utf8");
for (const value of [
  "until revoked",
  "ceiling",
  "pi mcp login slnctrz",
  "codex mcp login slnctrz",
  "opencode mcp auth slnctrz",
  "Full",
  "unreleased"
])
  requireText(gatewayOnly, value, "GATEWAY_ONLY");
requireText(backup, "schema v3", "BACKUP_RESTORE");

// Operational commands must match the real standalone CLI, not imagined service verbs.
for (const [guide, label] of [
  [userGuide, "USER_GUIDE"],
  [backup, "BACKUP_RESTORE"],
  [troubleshooting, "TROUBLESHOOTING"]
]) {
  for (const command of ["slnctrz-mcp start", "slnctrz-mcp stop"]) {
    forbidText(guide, command, label);
  }
}
requireText(userGuide, "uninstall --yes --purge", "USER_GUIDE purge semantics");
requireText(backup, "Binary-only rollback", "BACKUP_RESTORE schema compatibility");
requireText(
  mcpServers,
  "not an internal endpoint for scanning machines",
  "MCP_SERVERS protocol discovery boundary"
);
requireText(threatModel, "not direct SEA", "THREAT_MODEL manifest signing boundary");

// Public navigation integrity: every relative markdown link must resolve and every
// anchor must exist. Substring assertions alone let dead links ship (see AUDIT 37, F-A2).
const stripCode = (text) => text.replace(/```[\s\S]*?```/gu, "").replace(/`[^`\n]*`/gu, "");
function anchorCandidates(heading) {
  const cleaned = heading
    .toLowerCase()
    .replace(/<[^>]*>/gu, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim();
  // Accept GitHub's per-space dashes and the collapsed form so the check fails only
  // on genuinely missing anchors.
  return [
    cleaned.replace(/\s/gu, "-").replace(/_/gu, "-"),
    cleaned.replace(/\s+/gu, "-").replace(/_/gu, "-"),
    cleaned.replace(/\s+/gu, "").replace(/_/gu, "-")
  ];
}
const publicMarkdown = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".md")) publicMarkdown.push(join(root, entry.name));
}
for (const directory of ["docs", "skills"]) {
  for (const entry of await readdir(join(root, directory), {
    withFileTypes: true,
    recursive: true
  })) {
    if (entry.isFile() && entry.name.endsWith(".md"))
      publicMarkdown.push(join(entry.parentPath, entry.name));
  }
}
const markdownCache = new Map();
const readPublic = async (path) => {
  let value = markdownCache.get(path);
  if (value === undefined) {
    value = await readFile(path, "utf8").catch(() => undefined);
    markdownCache.set(path, value);
  }
  return value;
};
for (const file of publicMarkdown) {
  const text = await readPublic(file);
  if (text === undefined) continue;
  for (const match of stripCode(text).matchAll(/\]\(([^)\s]+)\)/gu)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    const [rawPath, rawAnchor] = target.split("#");
    const linkPath = decodeURIComponent(rawPath ?? "");
    const resolved = linkPath.length === 0 ? file : resolve(dirname(file), linkPath);
    const label = `${relative(root, file)} -> ${target}`;
    const linked = await readPublic(resolved);
    if (linked === undefined) throw new Error(`docs_contract_failed: dead link ${label}`);
    if (rawAnchor === undefined) continue;
    const anchors = new Set();
    for (const heading of linked.matchAll(/^#{1,6}\s+(.*)$/gmu)) {
      for (const candidate of anchorCandidates(heading[1])) anchors.add(candidate);
    }
    if (!anchors.has(decodeURIComponent(rawAnchor).toLowerCase()))
      throw new Error(`docs_contract_failed: dead anchor ${label}`);
  }
}
console.log(JSON.stringify({ status: "pass", version: pkg.version, node: pkg.engines.node }));
