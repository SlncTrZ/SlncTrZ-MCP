/** Reproducible coding-harness preflight benchmark with a maximum-size skill catalog. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessRuntime } from "../dist/context/runtime.js";
import { createKernelPolicySnapshot } from "../dist/policy/kernel-policy.js";

const DEFAULT_SKILLS = 128;
const DEFAULT_ITERATIONS = 30;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_CONCURRENT_REQUESTS = 64;

function positiveInteger(raw, fallback, name, maximum) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error(`Unknown or incomplete benchmark argument: ${key ?? ""}`);
    }
    values.set(key, value);
  }
  for (const key of values.keys()) {
    if (!["--skills", "--iterations", "--concurrency", "--requests"].includes(key)) {
      throw new Error(`Unknown benchmark argument: ${key}`);
    }
  }
  return {
    skills: positiveInteger(values.get("--skills"), DEFAULT_SKILLS, "skills", DEFAULT_SKILLS),
    iterations: positiveInteger(values.get("--iterations"), DEFAULT_ITERATIONS, "iterations", 500),
    concurrency: positiveInteger(
      values.get("--concurrency"),
      DEFAULT_CONCURRENCY,
      "concurrency",
      64
    ),
    requests: positiveInteger(
      values.get("--requests"),
      DEFAULT_CONCURRENT_REQUESTS,
      "requests",
      10_000
    )
  };
}

function percentile(samples, percentileValue) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil((percentileValue / 100) * sorted.length) - 1] ?? 0;
}

function summarize(samples) {
  return {
    count: samples.length,
    minMs: Math.min(...samples),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99),
    maxMs: Math.max(...samples)
  };
}

async function createFixture(skillCount) {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-harness-benchmark-"));
  await writeFile(join(root, "AGENTS.md"), "BENCHMARK-GLOBAL-INSTRUCTIONS\n", "utf8");
  for (let index = 0; index < skillCount; index += 1) {
    const name = `skill-${String(index).padStart(3, "0")}`;
    const directory = join(root, "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      [
        "---",
        `name: ${name}`,
        `description: Benchmark skill ${index}`,
        "---",
        `BENCHMARK-SKILL-${index}`,
        ""
      ].join("\n"),
      "utf8"
    );
  }
  return root;
}

function actor(root) {
  return {
    principal: { clientId: "benchmark-client", scopes: ["mcp:tools"] },
    policy: createKernelPolicySnapshot({ workspaceId: "benchmark", readRoot: root })
  };
}

async function measure(operation) {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = await createFixture(options.skills);
  try {
    const runtime = new HarnessRuntime(root);
    const a = actor(root);
    const boot = await runtime.bootstrap(a);
    await runtime.requireContext(a, boot.contextToken);

    const sequentialSamples = [];
    for (let index = 0; index < options.iterations; index += 1) {
      sequentialSamples.push(await measure(() => runtime.requireContext(a, boot.contextToken)));
    }

    const concurrentSamples = [];
    let next = 0;
    const concurrentStarted = performance.now();
    await Promise.all(
      Array.from({ length: options.concurrency }, async () => {
        while (next < options.requests) {
          next += 1;
          concurrentSamples.push(await measure(() => runtime.requireContext(a, boot.contextToken)));
        }
      })
    );
    const concurrentElapsedMs = performance.now() - concurrentStarted;

    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          environment: {
            platform: process.platform,
            architecture: process.arch,
            nodeVersion: process.version
          },
          catalogSkills: options.skills,
          sequentialPreflight: summarize(sequentialSamples),
          concurrency: {
            width: options.concurrency,
            requests: options.requests,
            elapsedMs: concurrentElapsedMs,
            requestsPerSecond: (options.requests * 1000) / concurrentElapsedMs,
            latency: summarize(concurrentSamples)
          }
        },
        null,
        2
      )}\n`
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
