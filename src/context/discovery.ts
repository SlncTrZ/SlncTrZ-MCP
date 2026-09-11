/**
 * Harness Discovery — bounded global/project instructions and Agent Skills metadata.
 * Wing: context | Topic: progressive-disclosure | Updated: 2026-09-11
 */

import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import {
  assertNonSecretPath,
  isContainedPath,
  resolveBoundaryRoot
} from "../kernel/fs-boundary.js";
import { ReadError, readContainedFile } from "../kernel/fs-read.js";
import {
  authorizeKernelCapability,
  type AuthenticatedPrincipal,
  type KernelPolicySnapshot
} from "../policy/kernel-policy.js";

export const MAX_INSTRUCTIONS_BYTES = 32 * 1024;
export const MAX_SKILL_BYTES = 256 * 1024;
export const MAX_RESOURCE_BYTES = 1024 * 1024;
export const MAX_SKILLS = 128;
export const MAX_DIRECTORY_ENTRIES = 512;
export const MAX_CONTEXT_BYTES = 256 * 1024;
const SKILL_DISCOVERY_CONCURRENCY = 16;
const MAX_SKILL_METADATA_CACHE = 512;

interface ParsedSkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly compatibility?: string;
}

const skillMetadataCache = new Map<string, ParsedSkillMetadata>();

export class HarnessError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "HarnessError";
  }
}

export interface HarnessActor {
  readonly principal: AuthenticatedPrincipal;
  readonly policy: KernelPolicySnapshot;
}

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly scope: "global" | "project";
  readonly sha256: string;
  readonly compatibility?: string;
}

export interface DiscoveredSkill {
  readonly metadata: SkillMetadata;
  readonly root: string;
  readonly directory: string;
  readonly bytes: number;
}

export interface ContextInstructions {
  readonly scope: "global" | "project";
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export interface ContextSnapshot {
  readonly revision: string;
  readonly instructions: readonly ContextInstructions[];
  readonly catalog: readonly SkillMetadata[];
  readonly skills: ReadonlyMap<string, DiscoveredSkill>;
  readonly diagnostics: readonly { source: string; code: string }[];
  readonly projectRoot?: string;
}

/** No symlink or junction may turn a declared context directory into a new read root. */
export async function assertContextPath(root: string, path = ""): Promise<string> {
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path.split("/").includes("..")
  ) {
    throw new HarnessError(
      "context_path_denied",
      "Use a relative path inside the skill directory."
    );
  }
  assertNonSecretPath(path);
  const target = resolve(root, path);
  if (!isContainedPath(resolve(root), target))
    throw new HarnessError("context_path_denied", "Context path escapes its root.");
  let current = root;
  for (const part of ["", ...path.split("/").filter(Boolean)]) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new HarnessError("context_path_denied", "Context symlinks are not supported.");
  }
  return target;
}

export async function readContextFile(root: string, path: string, maxBytes: number) {
  await assertContextPath(root, path);
  return readContainedFile(root, path, maxBytes);
}

function missing(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException).code === "ENOENT" ||
    (error instanceof ReadError && error.code === "not_found")
  );
}

export function parseSkillMetadata(content: string): ParsedSkillMetadata {
  const normalized = content.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  if (match?.[1] === undefined || Buffer.byteLength(match[1]) > 8192) {
    throw new HarnessError("skill_invalid_frontmatter", "SKILL.md needs bounded YAML frontmatter.");
  }
  const document = parseDocument(match[1], { uniqueKeys: true, prettyErrors: false, strict: true });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new HarnessError("skill_invalid_frontmatter", "SKILL.md frontmatter is invalid.");
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new HarnessError(
      "skill_invalid_frontmatter",
      "YAML aliases are not supported in skill metadata."
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarnessError("skill_invalid_frontmatter", "Skill metadata must be a mapping.");
  }
  const fields = value as Record<string, unknown>;
  if (
    typeof fields.name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(fields.name) ||
    fields.name.length > 64 ||
    typeof fields.description !== "string" ||
    fields.description.trim().length === 0 ||
    fields.description.length > 1024 ||
    (fields.compatibility !== undefined &&
      (typeof fields.compatibility !== "string" || fields.compatibility.length > 500))
  ) {
    throw new HarnessError(
      "skill_invalid_metadata",
      "Skill name, description or compatibility is invalid."
    );
  }
  return {
    name: fields.name,
    description: fields.description.trim(),
    ...(typeof fields.compatibility === "string" ? { compatibility: fields.compatibility } : {})
  };
}

function parseSkillMetadataCached(content: string, sha256: string): ParsedSkillMetadata {
  const cached = skillMetadataCache.get(sha256);
  if (cached !== undefined) return cached;
  const parsed = parseSkillMetadata(content);
  if (skillMetadataCache.size >= MAX_SKILL_METADATA_CACHE) {
    const oldest = skillMetadataCache.keys().next().value as string | undefined;
    if (oldest !== undefined) skillMetadataCache.delete(oldest);
  }
  skillMetadataCache.set(sha256, parsed);
  return parsed;
}

export async function resolveProjectRoot(actor: HarnessActor, requested: string): Promise<string> {
  if (!isAbsolute(requested))
    throw new HarnessError(
      "project_context_denied",
      "projectRoot must be an absolute gateway path."
    );
  const auth = authorizeKernelCapability(actor.policy, actor.principal, "core.read");
  if (auth.readAllowlist !== undefined)
    throw new HarnessError(
      "project_context_denied",
      "Project discovery requires unrestricted reads within an authorized Path."
    );
  const target = await resolveBoundaryRoot(requested);
  if (auth.authorityMode !== "autonomous") {
    let allowed = false;
    for (const root of auth.readRoots ?? [auth.root]) {
      if (isContainedPath(await resolveBoundaryRoot(root), target)) allowed = true;
    }
    if (!allowed)
      throw new HarnessError("project_context_denied", "Project is outside authorized Paths.");
  }
  return target;
}

export async function discoverContext(
  globalRoot: string,
  projectRoot?: string
): Promise<ContextSnapshot> {
  const instructions: ContextInstructions[] = [];
  const skills = new Map<string, DiscoveredSkill>();
  const diagnostics: { source: string; code: string }[] = [];
  const sources: { root: string; scope: "global" | "project"; skills: string[] }[] = [
    { root: globalRoot, scope: "global", skills: ["skills"] },
    ...(projectRoot === undefined
      ? []
      : [{ root: projectRoot, scope: "project" as const, skills: [".agents/skills", "skills"] }])
  ];
  for (const source of sources) {
    try {
      const result = await readContextFile(source.root, "AGENTS.md", MAX_INSTRUCTIONS_BYTES);
      instructions.push({
        scope: source.scope,
        path: join(source.root, "AGENTS.md"),
        content: result.content,
        sha256: result.sha256
      });
    } catch (error) {
      if (!missing(error))
        throw new HarnessError(
          "instructions_unavailable",
          "AGENTS.md cannot be read safely or exceeds the context limit."
        );
    }
    for (const skillPath of source.skills) {
      let names: string[] = [];
      try {
        const path = await assertContextPath(source.root, skillPath);
        const directory = await opendir(path);
        let count = 0;
        for await (const entry of directory) {
          if (++count > MAX_DIRECTORY_ENTRIES)
            throw new HarnessError(
              "skill_catalog_limit",
              "Too many entries in a skills directory."
            );
          if (entry.isDirectory()) names.push(entry.name);
          else if (entry.isSymbolicLink())
            diagnostics.push({
              source: `${source.scope}/${skillPath}/${entry.name}`,
              code: "context_path_denied"
            });
        }
      } catch (error) {
        if (missing(error)) continue;
        throw new HarnessError(
          "skill_catalog_unavailable",
          "A skills directory is unsafe, unreadable or exceeds its entry limit."
        );
      }
      names = names.sort();
      for (let offset = 0; offset < names.length; offset += SKILL_DISCOVERY_CONCURRENCY) {
        const batch = await Promise.all(
          names.slice(offset, offset + SKILL_DISCOVERY_CONCURRENCY).map(async (name) => {
            const directory = `${skillPath}/${name}`;
            const label = `${source.scope}/${directory}`;
            try {
              const file = await readContextFile(
                source.root,
                `${directory}/SKILL.md`,
                MAX_SKILL_BYTES
              );
              return {
                name,
                directory,
                label,
                file,
                parsed: parseSkillMetadataCached(file.content, file.sha256)
              };
            } catch (error) {
              return { name, directory, label, error };
            }
          })
        );
        for (const result of batch) {
          if ("error" in result) {
            if (!missing(result.error)) {
              diagnostics.push({
                source: result.label,
                code: result.error instanceof HarnessError ? result.error.code : "skill_unreadable"
              });
            }
            continue;
          }
          if (result.parsed.name !== result.name)
            diagnostics.push({
              source: result.label,
              code: "skill_directory_name_mismatch"
            });
          if (skills.has(result.parsed.name))
            diagnostics.push({ source: result.label, code: "skill_shadows_previous" });
          skills.set(result.parsed.name, {
            metadata: { ...result.parsed, scope: source.scope, sha256: result.file.sha256 },
            root: source.root,
            directory: result.directory,
            bytes: result.file.bytes
          });
          if (skills.size > MAX_SKILLS)
            throw new HarnessError(
              "skill_catalog_limit",
              `At most ${MAX_SKILLS} skills may be active.`
            );
        }
      }
    }
  }
  const catalog = [...skills.values()]
    .map((entry) => entry.metadata)
    .sort((a, b) => a.name.localeCompare(b.name));
  const canonical = JSON.stringify({ instructions, catalog, diagnostics, projectRoot });
  if (Buffer.byteLength(canonical) > MAX_CONTEXT_BYTES)
    throw new HarnessError(
      "context_budget_exceeded",
      "Instructions and catalog exceed the context budget."
    );
  return {
    revision: createHash("sha256").update(canonical).digest("hex"),
    instructions,
    catalog,
    skills,
    diagnostics,
    ...(projectRoot === undefined ? {} : { projectRoot })
  };
}

export function relativeResourcePath(skill: DiscoveredSkill, resource: string): string {
  const root = join(skill.root, skill.directory);
  const normalized = resource.replaceAll("\\", "/");
  if (
    isAbsolute(resource) ||
    /^[a-z]:/iu.test(resource) ||
    normalized.split("/").includes("..") ||
    resource.includes("\0") ||
    resource.length === 0
  ) {
    throw new HarnessError(
      "skill_resource_denied",
      "Resource must be a relative path within the activated skill."
    );
  }
  const path = resolve(root, normalized);
  if (!isContainedPath(root, path))
    throw new HarnessError("skill_resource_denied", "Resource escapes the skill.");
  return relative(skill.root, path).replaceAll("\\", "/");
}
