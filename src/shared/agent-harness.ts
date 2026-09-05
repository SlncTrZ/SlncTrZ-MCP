/** Canonical SlncTrZ product working guidance extracted from the product-owned AGENTS.md. */

import { createHash } from "node:crypto";

export const AGENT_HARNESS_ID = "slnctrz-agent-working-harness";
export const AGENT_HARNESS_SCHEMA_VERSION = 1;
export const MAX_AGENT_HARNESS_BYTES = 16 * 1024;

const BEGIN_MARKER = "<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_BEGIN -->";
const END_MARKER = "<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_END -->";

export interface AgentHarness {
  readonly id: typeof AGENT_HARNESS_ID;
  readonly schemaVersion: typeof AGENT_HARNESS_SCHEMA_VERSION;
  readonly sha256: string;
  readonly content: string;
}

export function extractCanonicalAgentHarness(source: string): AgentHarness {
  const begin = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER);

  if (
    begin < 0 ||
    end < 0 ||
    begin !== source.lastIndexOf(BEGIN_MARKER) ||
    end !== source.lastIndexOf(END_MARKER) ||
    end <= begin
  ) {
    throw new Error("agent_harness_markers_invalid");
  }

  const content = source.slice(begin + BEGIN_MARKER.length, end).trim();
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes === 0) throw new Error("agent_harness_empty");
  if (bytes > MAX_AGENT_HARNESS_BYTES) throw new Error("agent_harness_too_large");

  return Object.freeze({
    id: AGENT_HARNESS_ID,
    schemaVersion: AGENT_HARNESS_SCHEMA_VERSION,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    content
  });
}

export function buildAgentHarnessInstructions(harness: AgentHarness): string {
  return [
    "SlncTrZ Product Agent Harness.",
    "This is product working guidance, not authorization or a security boundary.",
    "Kernel/Auth/Policy remain authoritative. Project/workspace instructions are separate contextual guidance; if textual instructions conflict, surface the conflict instead of silently averaging them.",
    "",
    harness.content
  ].join("\n");
}
