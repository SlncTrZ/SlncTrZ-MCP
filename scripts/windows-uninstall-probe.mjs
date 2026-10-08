import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const variant = process.argv[2] ?? "cmd-net";
const root = await mkdtemp(join(tmpdir(), "slnctrz-helper-net-probe-"));
const log = join(root, "phases.log");
const literal = "'" + log.replaceAll("'", "''") + "'";
const psLog = (phase) =>
  "[IO.File]::AppendAllText(" + literal + ", '" + phase + "' + [Environment]::NewLine)";
const src = "src/standalone/product-management.ts";
const original = await readFile(src, "utf8");
const tick = String.fromCharCode(96);
const dollar = String.fromCharCode(36);
let source = original
  .replaceAll("Start-Sleep -Milliseconds 50", "[Threading.Thread]::Sleep(50)")
  .replaceAll("Start-Sleep -Milliseconds 250", "[Threading.Thread]::Sleep(250)");
source = source.replace(
  "Wait-Process -Id $parentPid -ErrorAction SilentlyContinue",
  "try { [Diagnostics.Process]::GetProcessById($parentPid).WaitForExit() } catch { }"
);
source = source.replace(
  "if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop }",
  "if ([IO.Directory]::Exists($target)) { [IO.Directory]::Delete($target, $true) } elseif ([IO.File]::Exists($target)) { [IO.File]::Delete($target) }"
);
source = source.replace(
  "Remove-Item -LiteralPath " +
    dollar +
    "{powershellLiteral(handshakeRoot)} -Recurse -Force -ErrorAction SilentlyContinue",
  "[IO.Directory]::Delete(" + dollar + "{powershellLiteral(handshakeRoot)}, $true)"
);
const parentLine = "    " + tick + "$parentPid=" + dollar + "{process.pid}" + tick + ",";
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
const waitLine =
  '    "  try { [Diagnostics.Process]::GetProcessById($parentPid).WaitForExit() } catch { }",';
source = source.replace(
  waitLine,
  "    " +
    JSON.stringify(psLog("go-observed")) +
    ",\n" +
    waitLine +
    "\n    " +
    JSON.stringify(psLog("parent-exited")) +
    ","
);
source = source.replace(
  '    "    catch { [Threading.Thread]::Sleep(250) }",',
  "    " +
    JSON.stringify(
      "    catch { [IO.File]::AppendAllText(" +
        literal +
        ", ('remove-error=' + $_.FullyQualifiedErrorId + '; hresult=' + $_.Exception.HResult + [Environment]::NewLine)); [Threading.Thread]::Sleep(250) }"
    ) +
    ","
);
const finalPatch = "} finally { " + psLog("helper-finally") + "; [IO.Directory]::Delete(";
source = source.replace("} finally { [IO.Directory]::Delete(", finalPatch.replaceAll("\\", "\\\\"));
source = source.replace(
  '    await atomicText(goFile, "go", 0o600);',
  '    await atomicText(goFile, "go", 0o600);\n    await writeFile(' +
    JSON.stringify(log) +
    ', "parent-wrote-go\\ncmd-pid=" + child.pid + "\\nparent-pid=" + process.pid + "\\n" + JSON.stringify({ goPath: goFile }) + "\\n", { flag: "a" });'
);
const nativeSource =
  'using System;\nusing System.Text;\nusing System.ComponentModel;\nusing System.Runtime.InteropServices;\npublic static class UninstallWorkerLauncher {\n  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]\n  public struct StartupInfo {\n    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;\n    public int dwX; public int dwY; public int dwXSize; public int dwYSize;\n    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;\n    public int dwFlags; public short wShowWindow; public short cbReserved2;\n    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;\n  }\n  [StructLayout(LayoutKind.Sequential)]\n  public struct ProcessInfo { public IntPtr hProcess; public IntPtr hThread; public int processId; public int threadId; }\n  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]\n  static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,\n    IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,\n    ref StartupInfo startup, out ProcessInfo process);\n  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);\n  public static int Start(string application, string command, string directory) {\n    StartupInfo startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo));\n    startup.dwFlags = 1; startup.wShowWindow = 0;\n    ProcessInfo process;\n    if (!CreateProcess(application, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,\n      0x01000010, IntPtr.Zero, directory, ref startup, out process))\n      throw new Win32Exception(Marshal.GetLastWin32Error());\n    CloseHandle(process.hThread); CloseHandle(process.hProcess); return process.processId;\n  }\n}';
if (variant === "breakaway-net") {
  const before = [
    psLog("before-add-type"),
    "Add-Type -TypeDefinition @'",
    nativeSource,
    "'@",
    psLog("after-add-type")
  ];
  const after = ["Wait-Process -Id $workerPid -ErrorAction SilentlyContinue"];
  source = source.replace(
    '  const encoded = Buffer.from(script, "utf16le").toString("base64");',
    [
      '  const workerCommand = \'"\' + powershell + \'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand \' + Buffer.from(script, "utf16le").toString("base64");',
      '  const launcherFile = join(handshakeRoot, "launcher.ps1");',
      "  const bootstrap = [" + before.map(JSON.stringify).join(",") + ",",
      '    "$workerPid = [UninstallWorkerLauncher]::Start(" + powershellLiteral(powershell) + ", " + powershellLiteral(workerCommand) + ", " + powershellLiteral(dirname(handshakeRoot)) + ")",',
      after.map(JSON.stringify).join(",") + '].join("\\n");',
      '  await writeFile(launcherFile, bootstrap, { encoding: "utf8", mode: 0o600, flag: "wx" });'
    ].join("\n")
  );
  source = source
    .replace(
      /    join\(systemRoot, "System32", "cmd.exe"\),[\s\S]*?\n    \],/u,
      '    powershell,\n    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcherFile],'
    )
    .replace("      detached: true,", "      detached: false,")
    .replace("      windowsVerbatimArguments: true,", "      windowsVerbatimArguments: false,")
    .replace("performance.now() + 15_000", "performance.now() + 90_000");
}
await writeFile(src, source);
await mkdir("_runtime", { recursive: true });
const smoke = (await readFile("scripts/smoke-uninstall.mjs", "utf8"))
  .replace("of cases)", "of cases.slice(0, 1))")
  .replace('["default", "remove-config", "purge"]', '["default"]')
  .replace(/timeout: 30000/g, "timeout: 120000");
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
  const started = Date.now();
  const run = spawnSync(process.execPath, ["_runtime/hosted-uninstall-first-case.mjs"], {
    encoding: "utf8",
    timeout: 180000
  });
  console.log(
    JSON.stringify({
      variant,
      elapsedMs: Date.now() - started,
      smokeExitCode: run.status,
      stdout: run.stdout,
      stderr: run.stderr
    })
  );
  console.log("HELPER_PHASES_BEGIN");
  const phases = await readFile(log, "utf8").catch(() => "NO_PHASES");
  console.log(phases);
  console.log("HELPER_PHASES_END");
  for (const match of phases.matchAll(/(?:cmd|helper|parent)-pid=(\d+)/g)) {
    const p = spawnSync(
      join(process.env.SystemRoot, "System32", "tasklist.exe"),
      ["/FI", "PID eq " + match[1], "/FO", "CSV", "/NH"],
      { encoding: "utf8", timeout: 10000 }
    );
    console.log(JSON.stringify({ pid: match[1], snapshot: p.stdout.trim(), exitCode: p.status }));
  }
  for (const line of phases.split(/\r?\n/))
    if (line.startsWith('{"goPath"')) {
      const p = JSON.parse(line).goPath;
      console.log(
        JSON.stringify({ goMarkerAfterExit: await readFile(p, "utf8").catch((e) => e.code) })
      );
    }
} finally {
  await writeFile(src, original);
  await rm(root, { recursive: true, force: true });
}
