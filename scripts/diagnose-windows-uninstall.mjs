/** Diagnose native Windows uninstall using disposable fixtures and environment variants. */
import { readFile, writeFile, mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") throw new Error("native Windows required");
const candidate = resolve("dist", "standalone", "win32-x64", "slnctrz-mcp.exe");
if (!(await stat(candidate)).isFile()) throw new Error("build native Windows artifact first");

const windowsKeys = [
  "ComSpec",
  "PATHEXT",
  "SystemDrive",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "HOMEDRIVE",
  "HOMEPATH"
];
const minimal = {
  PATH: process.env.PATH ?? "",
  SystemRoot: process.env.SystemRoot ?? "",
  WINDIR: process.env.WINDIR ?? ""
};
const windowsEnvironment = Object.fromEntries(
  windowsKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))
);
console.log(
  JSON.stringify({
    node: process.version,
    systemVariables: windowsKeys.map((key) => ({ key, present: process.env[key] !== undefined }))
  })
);

for (const [name, environment] of [
  ["minimal", minimal],
  ["windows-system", { ...minimal, ...windowsEnvironment }]
]) {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-cleanup-bootstrap-"));
  let log;
  try {
    const marker = join(root, "helper-started.txt");
    log = await open(join(root, "helper-output.txt"), "w");
    const script = "[IO.File]::WriteAllText('" + marker.replaceAll("'", "''") + "','started')";
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const run = spawnSync(
      "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded
      ],
      {
        cwd: root,
        env: environment,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log.fd, log.fd],
        timeout: 30000
      }
    );
    const output = await readFile(join(root, "helper-output.txt"), "utf8");
    const started = await readFile(marker, "utf8").then(
      () => true,
      () => false
    );
    console.log(
      JSON.stringify({
        probe: name,
        exitCode: run.status,
        started,
        output,
        error: run.error?.code
      })
    );
  } finally {
    await log?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) {
    throw new Error("diagnostic source contract changed: " + before);
  }
  return source.replace(before, after);
}

const source = await readFile("scripts/smoke-uninstall.mjs", "utf8");
const firstCase = replaceOnce(
  replaceOnce(source, "of cases)", "of cases.slice(0, 1))"),
  '["default", "remove-config", "purge"]',
  '["default"]'
);
const withWindowsEnvironment = replaceOnce(
  firstCase,
  "env: {",
  "env: {\n            ...Object.fromEntries(" +
    JSON.stringify(windowsKeys) +
    ".flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])),"
);
const variants = [
  ["minimal-15s", firstCase],
  ["windows-system-15s", withWindowsEnvironment],
  ["minimal-60s", replaceOnce(firstCase, "Date.now() + 15000", "Date.now() + 60000")]
];

await mkdir("_runtime", { recursive: true });
const variantsRoot = await mkdtemp(join(resolve("_runtime"), "uninstall-diagnostics-"));
try {
  for (const [name, content] of variants) {
    const path = join(variantsRoot, name + ".mjs");
    await writeFile(path, content);
    const syntax = spawnSync(process.execPath, ["--check", path], {
      encoding: "utf8",
      timeout: 10000
    });
    if (syntax.status !== 0) throw new Error("generated diagnostic syntax invalid: " + name);
    const started = Date.now();
    const run = spawnSync(process.execPath, [path], { encoding: "utf8", timeout: 120000 });
    console.log(
      JSON.stringify({
        variant: name,
        exitCode: run.status,
        elapsedMs: Date.now() - started,
        stdout: run.stdout,
        stderr: run.stderr,
        error: run.error?.code
      })
    );
  }
} finally {
  await rm(variantsRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}
console.log(JSON.stringify({ status: "diagnostics-complete", cleanup: "complete" }));
