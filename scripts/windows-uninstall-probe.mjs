import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = await mkdtemp(join(tmpdir(), "slnctrz-hosted-uninstall-probe-"));
const log = join(root, "phases.log");
const literal = "'" + log.replaceAll("'", "''") + "'";
const psLog = (phase) =>
  "[IO.File]::AppendAllText(" + literal + ", '" + phase + "' + [Environment]::NewLine)";
const src = "src/standalone/product-management.ts";
const original = await readFile(src, "utf8");
let source = original;
const tick = String.fromCharCode(96);
const parentLine =
  "    " + tick + "$parentPid=" + String.fromCharCode(36) + "{process.pid}" + tick + ",";
source = source.replace(parentLine, parentLine + "\n    " + JSON.stringify(psLog("started")) + ",");
source = source.replace(
  '    "  $deadline = [DateTime]::UtcNow.AddSeconds(20)",',
  "    " +
    JSON.stringify(psLog("ready-written")) +
    ',\n    "  $deadline = [DateTime]::UtcNow.AddSeconds(20)",'
);
source = source.replace(
  '    "  Wait-Process -Id $parentPid -ErrorAction SilentlyContinue",',
  "    " +
    JSON.stringify(psLog("go-observed")) +
    ',\n    "  Wait-Process -Id $parentPid -ErrorAction SilentlyContinue",\n    ' +
    JSON.stringify(psLog("parent-exited")) +
    ","
);
source = source.replace(
  '    "    catch { Start-Sleep -Milliseconds 250 }",',
  "    " +
    JSON.stringify(
      "    catch { [IO.File]::AppendAllText(" +
        literal +
        ", ('remove-error: ' + $_.FullyQualifiedErrorId + '; hresult=' + $_.Exception.HResult + [Environment]::NewLine)); Start-Sleep -Milliseconds 250 }"
    ) +
    ","
);
const finalPatch =
  "} catch { [IO.File]::AppendAllText(" +
  literal +
  ", ('outer-error: ' + $_.FullyQualifiedErrorId + '; hresult=' + $_.Exception.HResult + [Environment]::NewLine)); throw } finally { " +
  psLog("helper-finally") +
  "; Remove-Item -LiteralPath ";
source = source.replace(
  "} finally { Remove-Item -LiteralPath ",
  finalPatch.replaceAll("\\", "\\\\")
);
source = source.replace(
  '    await atomicText(goFile, "go", 0o600);',
  '    await atomicText(goFile, "go", 0o600);\n    await writeFile(' +
    JSON.stringify(log) +
    ', "parent-wrote-go\\n", { flag: "a" });'
);
if (source === original || !source.includes("outer-error"))
  throw new Error("instrumentation failed");
await writeFile(src, source);
await mkdir("_runtime", { recursive: true });
const smoke = (await readFile("scripts/smoke-uninstall.mjs", "utf8"))
  .replace("of cases)", "of cases.slice(0, 1))")
  .replace('["default", "remove-config", "purge"]', '["default"]');
await writeFile("_runtime/hosted-uninstall-first-case.mjs", smoke);
try {
  const { publicKey } = generateKeyPairSync("ed25519");
  const env = {
    ...process.env,
    SLNCTRZ_BUILD_COMMIT: process.env.GITHUB_SHA ?? "probe-local",
    SLNCTRZ_RELEASE_BASE_URL: "https://example.invalid/hosted-probe/",
    SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64: publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64")
  };
  const build = spawnSync(process.execPath, ["scripts/build-sea.mjs", "win32-x64"], {
    env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (build.status !== 0) {
    console.log(build.stdout, build.stderr);
    throw new Error("probe build failed");
  }
  const run = spawnSync(process.execPath, ["_runtime/hosted-uninstall-first-case.mjs"], {
    encoding: "utf8",
    timeout: 90000
  });
  console.log(
    JSON.stringify({ smokeExitCode: run.status, stdout: run.stdout, stderr: run.stderr })
  );
  console.log("HELPER_PHASES_BEGIN");
  console.log(await readFile(log, "utf8").catch(() => "NO_PHASES"));
  console.log("HELPER_PHASES_END");
} finally {
  await writeFile(src, original);
  await rm(root, { recursive: true, force: true });
}
