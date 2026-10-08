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
source = source.replace(
  parentLine,
  parentLine +
    "\n    " +
    JSON.stringify(psLog("started")) +
    ",\n    " +
    JSON.stringify(
      "[IO.File]::AppendAllText(" + literal + ", ('helper-pid=' + $PID + [Environment]::NewLine))"
    ) +
    ","
);
source = source.replace(
  '    "  $deadline = [DateTime]::UtcNow.AddSeconds(20)",',
  "    " +
    JSON.stringify(psLog("ready-written")) +
    ',\n    "  $deadline = [DateTime]::UtcNow.AddSeconds(20)",'
);
const waitLines = [
  psLog("go-observed"),
  "  $parent = $null",
  "  try { $parent = [Diagnostics.Process]::GetProcessById($parentPid) } catch { }",
  "  [IO.File]::AppendAllText(" +
    literal +
    ", ('parent-state: expected=' + $parentPid + '; helper=' + $PID + '; present=' + ($null -ne $parent) + [Environment]::NewLine))",
  "  $exitDeadline = [DateTime]::UtcNow.AddSeconds(15)",
  "  while ($null -ne $parent) { $parent.Refresh(); if ($parent.HasExited) { break }; if ([DateTime]::UtcNow -ge $exitDeadline) { throw 'parent_exit_timeout' }; Start-Sleep -Milliseconds 50 }",
  psLog("parent-exited")
];
source = source.replace(
  '    "  Wait-Process -Id $parentPid -ErrorAction SilentlyContinue",',
  waitLines.map((line) => "    " + JSON.stringify(line) + ",").join("\n")
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
source = source.replace(
  "      windowsHide: true,\n      windowsVerbatimArguments: true,",
  "      windowsHide: false,\n      windowsVerbatimArguments: true,"
);
source = source.replace(
  "    child.unref();",
  "    await writeFile(" +
    JSON.stringify(log) +
    ', "cmd-pid=" + child.pid + "\\nparent-pid=" + process.pid + "\\n", { flag: "a" });\n    child.unref();'
);
const nativeSource =
  'using System;\nusing System.Text;\nusing System.ComponentModel;\nusing System.Runtime.InteropServices;\npublic static class UninstallWorkerLauncher {\n  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]\n  public struct StartupInfo {\n    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;\n    public int dwX; public int dwY; public int dwXSize; public int dwYSize;\n    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;\n    public int dwFlags; public short wShowWindow; public short cbReserved2;\n    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;\n  }\n  [StructLayout(LayoutKind.Sequential)]\n  public struct ProcessInfo { public IntPtr hProcess; public IntPtr hThread; public int processId; public int threadId; }\n  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]\n  static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,\n    IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,\n    ref StartupInfo startup, out ProcessInfo process);\n  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);\n  public static int Start(string application, string command, string directory) {\n    StartupInfo startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo));\n    startup.dwFlags = 1; startup.wShowWindow = 0;\n    ProcessInfo process;\n    if (!CreateProcess(application, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,\n      0x01000010, IntPtr.Zero, directory, ref startup, out process))\n      throw new Win32Exception(Marshal.GetLastWin32Error());\n    CloseHandle(process.hThread); CloseHandle(process.hProcess); return process.processId;\n  }\n}';
const bootstrapLines = [
  "Add-Type -TypeDefinition @'",
  nativeSource,
  "'@",
  "try {",
  psLog("launcher-start")
];
const bootstrapSuffix = [
  psLog("launcher-worker-started"),
  "Wait-Process -Id $workerPid -ErrorAction SilentlyContinue",
  "} catch { [IO.File]::AppendAllText(" +
    literal +
    ", ('launcher-error=' + $_.FullyQualifiedErrorId + '; hresult=' + $_.Exception.HResult + [Environment]::NewLine)); exit 1 }"
];
source = source.replace(
  '  const encoded = Buffer.from(script, "utf16le").toString("base64");',
  [
    '  const workerCommand = \'"\' + powershell + \'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand \' + Buffer.from(script, "utf16le").toString("base64");',
    '  const launcherFile = join(handshakeRoot, "launcher.ps1");',
    "  const bootstrap = [" + bootstrapLines.map(JSON.stringify).join(",") + ",",
    '    "$workerPid = [UninstallWorkerLauncher]::Start(" + powershellLiteral(powershell) + ", " + powershellLiteral(workerCommand) + ", " + powershellLiteral(dirname(handshakeRoot)) + ")",',
    bootstrapSuffix.map(JSON.stringify).join(",") + '].join("\\n");',
    '  await writeFile(launcherFile, bootstrap, { encoding: "utf8", mode: 0o600, flag: "wx" });'
  ].join("\n")
);
source = source
  .replace(
    /    join\(systemRoot, "System32", "cmd.exe"\),[\s\S]*?\n    \],/u,
    '    powershell,\n    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcherFile],'
  )
  .replace("      detached: true,", "      detached: false,")
  .replace("      windowsVerbatimArguments: true,", "      windowsVerbatimArguments: false,");
if (source === original || !source.includes("outer-error"))
  throw new Error("instrumentation failed");
await writeFile(src, source);
await mkdir("_runtime", { recursive: true });
const smoke = (await readFile("scripts/smoke-uninstall.mjs", "utf8"))
  .replace("of cases)", "of cases.slice(0, 1))")
  .replace('["default", "remove-config", "purge"]', '["default"]')
  .replace(
    "env: {",
    'env: { ...Object.fromEntries(["ComSpec","PATHEXT","SystemDrive","TEMP","TMP","USERPROFILE","APPDATA","LOCALAPPDATA","ProgramData","HOMEDRIVE","HOMEPATH"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),'
  );
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
  console.log("PROBE_SMOKE_ENV=" + (smoke.includes("ComSpec") ? "windows-system" : "minimal"));
  console.log("HELPER_PHASES_BEGIN");
  console.log(await readFile(log, "utf8").catch(() => "NO_PHASES"));
  console.log("HELPER_PHASES_END");
  const phases = await readFile(log, "utf8").catch(() => "");
  for (const match of phases.matchAll(/(?:cmd|helper|parent)-pid=(\d+)/g)) {
    const p = spawnSync(
      join(process.env.SystemRoot, "System32", "tasklist.exe"),
      ["/FI", "PID eq " + match[1], "/FO", "CSV", "/NH"],
      { encoding: "utf8", timeout: 10000 }
    );
    console.log(JSON.stringify({ pid: match[1], snapshot: p.stdout.trim(), exitCode: p.status }));
  }
} finally {
  await writeFile(src, original);
  await rm(root, { recursive: true, force: true });
}
