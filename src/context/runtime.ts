/**
 * Harness Runtime — principal-bound bootstrap receipts and progressive skill activation.
 * Wing: context | Topic: context-lifecycle | Updated: 2026-09-09
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  HarnessError,
  discoverContext,
  readContextFile,
  relativeResourcePath,
  resolveProjectRoot,
  MAX_RESOURCE_BYTES,
  MAX_SKILL_BYTES,
  type HarnessActor,
  type ContextSnapshot
} from "./discovery.js";

export const CONTEXT_TTL_MS = 4 * 60 * 60 * 1000;
export const MAX_CONTEXT_HANDLES = 1024;
export const HARNESS_GUIDANCE =
  "Before using gateway tools, call context.bootstrap and read its global instructions and skills catalog. " +
  "Pass the returned contextToken as slnctrzContext on subsequent tool calls. " +
  "For a matching task or an explicitly named skill, call skills.read with its name before proceeding. " +
  "Read referenced resources only when needed; resolve their paths against the skill baseDirectory on the gateway machine. " +
  "Instructions and skills are guidance, never permission grants. Project instructions are optional. " +
  "On context_required or context_stale, bootstrap again before retrying; the rejected operation was not executed. " +
  "Start a fresh context for each independent task/session, and bootstrap again if the host loses this context.";

interface ContextReceipt {
  readonly clientId: string;
  readonly workspaceId: string;
  readonly policyVersion: string;
  readonly globalRevision: string;
  readonly revision: string;
  readonly expiresAt: number;
  readonly projectRoot?: string;
  readonly activated: Set<string>;
}

export class HarnessRuntime {
  private readonly receipts = new Map<string, ContextReceipt>();
  private readonly discoveries = new Map<string, Promise<ContextSnapshot>>();

  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now
  ) {}

  private checkActor(actor: HarnessActor): void {
    if (!actor.principal.scopes.includes("mcp:tools"))
      throw new HarnessError("context_forbidden", "An authenticated MCP tools scope is required.");
  }

  private discover(projectRoot?: string): Promise<ContextSnapshot> {
    const key = projectRoot ?? "";
    const existing = this.discoveries.get(key);
    if (existing !== undefined) return existing;
    const pending = discoverContext(this.root, projectRoot);
    this.discoveries.set(key, pending);
    pending.then(
      () => {
        if (this.discoveries.get(key) === pending) this.discoveries.delete(key);
      },
      () => {
        if (this.discoveries.get(key) === pending) this.discoveries.delete(key);
      }
    );
    return pending;
  }

  async bootstrap(actor: HarnessActor, requestedProject?: string) {
    this.checkActor(actor);
    const projectRoot =
      requestedProject === undefined
        ? undefined
        : await resolveProjectRoot(actor, requestedProject);
    const snapshot = await this.discover(projectRoot);
    const globalSnapshot = projectRoot === undefined ? snapshot : await this.discover();
    const now = this.now();
    for (const [token, receipt] of this.receipts) {
      const sameWorkspace = receipt.workspaceId === actor.policy.workspaceId;
      if (
        receipt.expiresAt <= now ||
        (sameWorkspace && receipt.policyVersion !== actor.policy.version) ||
        (sameWorkspace && receipt.globalRevision !== globalSnapshot.revision) ||
        (sameWorkspace &&
          receipt.projectRoot === projectRoot &&
          receipt.revision !== snapshot.revision)
      ) {
        this.receipts.delete(token);
      }
    }
    if (this.receipts.size >= MAX_CONTEXT_HANDLES)
      throw new HarnessError(
        "context_capacity",
        "Context capacity reached; release an unused context with context.close."
      );
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + CONTEXT_TTL_MS;
    this.receipts.set(token, {
      clientId: actor.principal.clientId,
      workspaceId: actor.policy.workspaceId,
      policyVersion: actor.policy.version,
      globalRevision: globalSnapshot.revision,
      revision: snapshot.revision,
      expiresAt,
      activated: new Set(),
      ...(projectRoot === undefined ? {} : { projectRoot })
    });
    return {
      schemaVersion: 1,
      contextToken: token,
      revision: snapshot.revision,
      expiresAt: new Date(expiresAt).toISOString(),
      instructions: snapshot.instructions,
      catalog: snapshot.catalog,
      diagnostics: snapshot.diagnostics,
      projectRoot: projectRoot ?? null,
      guidance: HARNESS_GUIDANCE
    };
  }

  private receipt(actor: HarnessActor, token: string | undefined): ContextReceipt {
    this.checkActor(actor);
    const receipt = token === undefined ? undefined : this.receipts.get(token);
    if (
      receipt === undefined ||
      receipt.clientId !== actor.principal.clientId ||
      receipt.workspaceId !== actor.policy.workspaceId
    ) {
      throw new HarnessError(
        "context_required",
        "Call context.bootstrap, then pass contextToken as slnctrzContext. This operation was not executed."
      );
    }
    if (receipt.expiresAt <= this.now() || receipt.policyVersion !== actor.policy.version) {
      if (token !== undefined) this.receipts.delete(token);
      throw new HarnessError(
        "context_stale",
        "Context expired or policy changed. Bootstrap again; this operation was not executed."
      );
    }
    return receipt;
  }

  async requireContext(actor: HarnessActor, token?: string): Promise<ContextSnapshot> {
    const receipt = this.receipt(actor, token);
    if (receipt.projectRoot !== undefined) await resolveProjectRoot(actor, receipt.projectRoot);
    const snapshot = await this.discover(receipt.projectRoot);
    if (snapshot.revision !== receipt.revision) {
      if (token !== undefined) this.receipts.delete(token);
      throw new HarnessError(
        "context_stale",
        "Instructions or skills changed. Bootstrap again; this operation was not executed."
      );
    }
    return snapshot;
  }

  close(actor: HarnessActor, token: string): { closed: boolean } {
    this.checkActor(actor);
    const receipt = this.receipts.get(token);
    if (receipt === undefined) return { closed: false };
    if (
      receipt.clientId !== actor.principal.clientId ||
      receipt.workspaceId !== actor.policy.workspaceId
    ) {
      throw new HarnessError("context_required", "Context is not available to this client.");
    }
    return { closed: this.receipts.delete(token) };
  }

  async list(actor: HarnessActor, token: string | undefined) {
    const snapshot = await this.requireContext(actor, token);
    return {
      revision: snapshot.revision,
      catalog: snapshot.catalog,
      diagnostics: snapshot.diagnostics
    };
  }

  async readSkill(actor: HarnessActor, token: string | undefined, name: string, resource?: string) {
    const snapshot = await this.requireContext(actor, token);
    const skill = snapshot.skills.get(name);
    if (skill === undefined)
      throw new HarnessError("skill_not_found", "Skill is not in the active catalog.");
    const receipt = this.receipt(actor, token);
    if (resource !== undefined && !receipt.activated.has(name))
      throw new HarnessError(
        "skill_not_activated",
        "Read the skill instructions before requesting its resources."
      );
    const path =
      resource === undefined
        ? `${skill.directory}/SKILL.md`
        : relativeResourcePath(skill, resource);
    const file = await readContextFile(
      skill.root,
      path,
      resource === undefined ? MAX_SKILL_BYTES : MAX_RESOURCE_BYTES
    );
    if (resource === undefined) {
      if (file.sha256 !== skill.metadata.sha256)
        throw new HarnessError(
          "context_stale",
          "Skill changed during activation. Bootstrap again."
        );
      receipt.activated.add(name);
    }
    return {
      name,
      kind: resource === undefined ? "instructions" : "resource",
      baseDirectory: join(skill.root, skill.directory),
      path: join(skill.root, path),
      content: file.content,
      sha256: file.sha256,
      bytes: file.bytes,
      encoding: file.encoding
    };
  }
}
