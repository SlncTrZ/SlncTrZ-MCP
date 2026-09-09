/**
 * Quality Gate Runner — runs static checks concurrently, then the timing-sensitive test suite.
 * Wing: scripts | Topic: quality-gate | Updated: 2026-09-09
 *
 * Provenance: ENGINEERING pre-commit requirements.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const staticChecks = [
  {
    name: "typecheck",
    script: "node_modules/typescript/bin/tsc",
    args: ["-p", "tsconfig.json", "--noEmit"]
  },
  {
    name: "lint",
    script: "node_modules/eslint/bin/eslint.js",
    args: ["."]
  },
  {
    name: "format",
    script: "node_modules/prettier/bin/prettier.cjs",
    args: ["--check", "**/*.{ts,json,md,yaml,yml}"]
  }
];

const testCheck = {
  name: "test",
  script: "node_modules/vitest/vitest.mjs",
  args: ["run"]
};

function runCheck(check) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [check.script, ...check.args], {
      cwd: root,
      stdio: "inherit"
    });

    child.once("error", (error) => {
      console.error(`${check.name}: ${error.message}`);
      resolve(false);
    });
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        console.error(`${check.name}: terminated by ${signal}`);
      }
      resolve(code === 0);
    });
  });
}

const staticResults = await Promise.all(staticChecks.map(runCheck));
if (staticResults.some((passed) => !passed)) {
  process.exitCode = 1;
} else if (!(await runCheck(testCheck))) {
  process.exitCode = 1;
}
