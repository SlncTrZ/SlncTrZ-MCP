/** Public documentation contract checks that fail CI when user-facing commands drift. */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readVersion, RELEASE_LINE_MARKER } from "./version.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const [
  readme,
  release,
  provenance,
  pkgRaw,
  agents,
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
  projectContextAdr
] = await Promise.all([
  readFile(join(root, "README.md"), "utf8"),
  readFile(join(root, "RELEASE.md"), "utf8"),
  readFile(join(root, "PROVENANCE.md"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
  readFile(join(root, "AGENTS.md"), "utf8"),
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
  readFile(join(root, "docs", "adr", "adr-009-project-instructions-explicit-context.md"), "utf8")
]);
const pkg = JSON.parse(pkgRaw);

function requireText(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`docs_contract_failed: ${label} missing ${JSON.stringify(needle)}`);
  }
}

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
  requireText(readme, command, "README");
}

for (const value of [
  "http://127.0.0.1:3100/mcp",
  "http://127.0.0.1:3100/owner",
  "/mcp",
  "docs/MODEL_GUIDE.md",
  "releases/latest/download/install.sh",
  "Windows x64 with Git Bash",
  "%LOCALAPPDATA%\\SlncTrZ-MCP",
  ">=22.13.0 <25"
]) {
  requireText(readme, value, "README");
}

if (pkg.engines?.node !== ">=22.13.0 <25") {
  throw new Error(
    "docs_contract_failed: package Node engine changed; update docs-check and public docs"
  );
}
// Release line is derived from package.json through the single version module, so CI
// never needs to hardcode a line. readVersion() throws if the shape is unsupported.
const { releaseLine } = await readVersion();

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
  requireText(agents, value, "AGENTS");
}
requireText(modelGuide, "structuredContent.modelGuide", "MODEL_GUIDE");
requireText(modelGuide, "structuredContent.agentHarness", "MODEL_GUIDE");
requireText(modelGuide, "core.ping", "MODEL_GUIDE");
requireText(modelGuide, "Restricted mode is a capability policy", "MODEL_GUIDE");
requireText(modelGuide, "task.start", "MODEL_GUIDE");
requireText(modelGuide, "task.create", "MODEL_GUIDE");
requireText(modelGuide, "in-memory only", "MODEL_GUIDE");
requireText(readme, "## Managed tasks", "README");
requireText(readme, "task.start", "README");
requireText(readme, "task.create", "README");
requireText(readme, "in-memory only", "README");
requireText(architecture, "## Managed Task Runtime", "ARCHITECTURE");
requireText(architecture, "Product Agent Harness", "ARCHITECTURE");
requireText(architecture, "task.start", "ARCHITECTURE");
requireText(autonomy, "task.start", "AUTONOMY");
requireText(autonomy, "Logical coordination tools", "AUTONOMY");
requireText(security, "Task Runtime is not a second privilege path", "SECURITY");
requireText(security, "coordination-task text cannot grant capabilities", "SECURITY");
requireText(threatModel, "### Managed task requirements", "THREAT_MODEL");
requireText(threatModel, "Task-state exhaustion", "THREAT_MODEL");
requireText(releaseAcceptance, "## Managed Task Runtime release acceptance", "RELEASE_ACCEPTANCE");
requireText(releaseAcceptance, "exactly one winner", "RELEASE_ACCEPTANCE");
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
requireText(deployment, "## Task Runtime lifecycle", "DEPLOYMENT");
requireText(deployment, "/var/lib/slnctrz-mcp", "DEPLOYMENT");
requireText(deployment, "/etc/slnctrz-mcp", "DEPLOYMENT");
requireText(troubleshooting, "running_version_mismatch", "TROUBLESHOOTING");
requireText(troubleshooting, "## Managed tasks after restart", "TROUBLESHOOTING");
requireText(backup, "secrets/owner-passphrase", "BACKUP_RESTORE");
requireText(backup, "Task Runtime state", "BACKUP_RESTORE");
requireText(projectContextAdr, "not implemented in the current source tree", "ADR-009");
requireText(projectContextAdr, "Product Agent Harness", "ADR-009");

console.log(JSON.stringify({ status: "pass", version: pkg.version, node: pkg.engines.node }));
