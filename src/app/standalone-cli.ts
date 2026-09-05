/** Standalone CLI — install/rollback plus small local owner diagnostics. */

import { isAbsolute } from "node:path";
import { fetchReleaseManifest } from "../standalone/manifest-fetch.js";
import { currentReleaseTarget } from "../standalone/release-manifest.js";
import { installStandaloneRelease, rollbackStandaloneRelease } from "../standalone/installer.js";
import { initializeDefaultWorkspace, managedStatePaths } from "../owner/managed-state.js";
import { APP_VERSION, BUILD_COMMIT } from "../shared/build-info.js";
import { prepareProductSetup } from "../standalone/product-setup.js";
import { activateSystemService } from "../standalone/service-setup.js";
import {
  discoverInstalledProduct,
  readProductStatus,
  repairProduct,
  rollbackProduct,
  rotateOwnerPassphrase,
  runDoctor,
  setProductConfig,
  showProductConfig,
  uninstallProduct,
  updateProduct,
  type ManagementDependencies
} from "../standalone/product-management.js";

export const STANDALONE_VERSION: string = APP_VERSION;

export interface CliOutput {
  write(message: string): void;
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}

function only(args: readonly string[], allowed: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== undefined && allowed.includes(arg)) {
      index += 1;
      continue;
    }
    throw new Error(`Unknown standalone CLI argument: ${arg}`);
  }
}

function absolute(value: string): string {
  if (!isAbsolute(value)) throw new Error("Path must be absolute");
  return value;
}

function onlyFlags(args: readonly string[], allowed: readonly string[]): void {
  for (const arg of args) {
    if (!allowed.includes(arg)) throw new Error(`Unknown standalone CLI argument: ${arg}`);
  }
}

function help(): string {
  return [
    "Usage: slnctrz-mcp [command]",
    "",
    "Commands:",
    "  setup [--mode user|system] [--port <1-65535>] [--path <absolute-path>] [--authority restricted|autonomous] [--public-url <https-url>]",
    "  status [--json]",
    "  doctor [--json]",
    "  config show [--json]",
    "  config set <port|public-url|owner-console|host> <value>",
    "  update [--manifest <https-url>]",
    "  rollback",
    "  repair",
    "  uninstall --yes [--remove-config|--purge]",
    "  install --manifest <https-url> --root <absolute-path>   # advanced",
    "  rollback --root <absolute-path>                         # advanced",
    "  owner init --root <absolute-path> [--state-root <absolute-path>]",
    "  owner rotate-passphrase",
    "  owner status",
    "  owner policy",
    "  owner reload",
    "  --help",
    "  --version",
    "  --build-info"
  ].join("\n");
}

async function ownerRequest(
  path: string,
  init: RequestInit,
  environment: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<unknown> {
  let secret = environment.SLNCTRZ_OWNER_SECRET;
  if (secret === undefined || secret.length === 0) {
    const context = await discoverInstalledProduct({
      ...(environment.SLNCTRZ_STATE_ROOT === undefined
        ? {}
        : { stateRoot: environment.SLNCTRZ_STATE_ROOT })
    });
    secret = (
      await (
        await import("node:fs/promises")
      ).readFile(context.statePaths.ownerPassphraseFile, "utf8")
    ).replace(/\r?\n$/u, "");
  }
  const host = environment.SLNCTRZ_CONTROL_HOST ?? "127.0.0.1";
  const port = environment.SLNCTRZ_CONTROL_PORT ?? "3101";
  const response = await fetchImpl(`http://${host}:${port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${secret}`, ...init.headers }
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) throw new Error(`Owner control request failed (${response.status})`);
  return body;
}

export async function runStandaloneCli(
  args: readonly string[],
  options: {
    readonly output?: CliOutput;
    readonly fetch?: typeof fetch;
    readonly environment?: NodeJS.ProcessEnv;
    readonly checkPort?: (host: string, port: number) => Promise<void>;
    readonly activateSystemService?: typeof activateSystemService;
    readonly management?: ManagementDependencies;
  } = {}
): Promise<boolean> {
  const output = options.output ?? { write: (message: string) => console.log(message) };
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const management: ManagementDependencies = {
    ...(options.management ?? {}),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.management?.stateRoot !== undefined
      ? {}
      : environment.SLNCTRZ_STATE_ROOT === undefined
        ? {}
        : { stateRoot: environment.SLNCTRZ_STATE_ROOT })
  };
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--help") {
    output.write(help());
    return true;
  }
  if (args.length === 1 && args[0] === "--version") {
    output.write(STANDALONE_VERSION);
    return true;
  }
  if (args.length === 1 && args[0] === "--build-info") {
    output.write(JSON.stringify({ version: STANDALONE_VERSION, buildCommit: BUILD_COMMIT }));
    return true;
  }
  if (args[0] === "setup") {
    const values = args.slice(1);
    only(values, [
      "--mode",
      "--port",
      "--path",
      "--authority",
      "--public-url",
      "--listen-host",
      "--manifest",
      "--install-root",
      "--state-root",
      "--config-root"
    ]);
    const mode = values.includes("--mode") ? option(values, "--mode") : "user";
    if (mode !== "user" && mode !== "system") throw new Error("--mode must be user or system");
    if (mode === "system") {
      if (process.platform !== "linux")
        throw new Error("System setup is currently supported only on Linux");
      if (process.getuid?.() !== 0) {
        throw new Error("permission_denied: system setup must run with root/sudo privileges");
      }
    }
    const authority = values.includes("--authority") ? option(values, "--authority") : "restricted";
    if (authority !== "restricted" && authority !== "autonomous") {
      throw new Error("--authority must be restricted or autonomous");
    }
    const rawPort = values.includes("--port") ? option(values, "--port") : "3100";
    const port = Number(rawPort);
    const setup = await prepareProductSetup(
      {
        installMode: mode,
        port,
        authorityMode: authority,
        ...(values.includes("--path") ? { initialPath: absolute(option(values, "--path")) } : {}),
        ...(values.includes("--public-url")
          ? { publicMcpUrl: option(values, "--public-url") }
          : {}),
        ...(values.includes("--listen-host")
          ? { listenHost: option(values, "--listen-host") }
          : {}),
        ...(values.includes("--manifest") ? { manifestUrl: option(values, "--manifest") } : {}),
        ...(values.includes("--install-root")
          ? { installRoot: absolute(option(values, "--install-root")) }
          : {}),
        ...(values.includes("--state-root")
          ? { stateRoot: absolute(option(values, "--state-root")) }
          : {}),
        ...(values.includes("--config-root")
          ? { configRoot: absolute(option(values, "--config-root")) }
          : {})
      },
      {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.checkPort === undefined ? {} : { checkPort: options.checkPort })
      }
    );
    const systemService =
      setup.installation.installMode === "system"
        ? await (options.activateSystemService ?? activateSystemService)(setup)
        : undefined;
    const lines = [
      "Setup Complete",
      "",
      `Version: ${setup.activation.version}`,
      `Install mode: ${setup.installation.installMode}`,
      `Runtime account: ${setup.runtimeAccount}`,
      `Authority: ${setup.installation.authorityMode}`,
      `Install location: ${setup.installation.installRoot}`,
      `State: ${setup.installation.stateRoot}`,
      `Config: ${setup.gatewayConfigFile}`,
      `Owner Console: ${setup.ownerConsoleUrl}`,
      `MCP Endpoint: ${setup.mcpEndpoint}`,
      `Owner Passphrase: ${setup.firstRunOwnerPassphrase ?? "preserved"}`,
      `Passphrase file: ${setup.ownerPassphraseFile}`,
      "",
      setup.installation.installMode === "user"
        ? process.platform === "win32"
          ? `Start: ${setup.launcherFile}`
          : `Start: SLNCTRZ_CONFIG_FILE=${setup.gatewayConfigFile} ${setup.launcherFile}`
        : `Service: ${systemService?.serviceName ?? "slnctrz-mcp.service"} (running)`
    ];
    output.write(lines.join("\n"));
    return true;
  }
  if (args[0] === "status") {
    const values = args.slice(1);
    onlyFlags(values, ["--json"]);
    const status = await readProductStatus(management);
    output.write(
      values.includes("--json")
        ? JSON.stringify(status)
        : [
            `SlncTrZ-MCP installed ${status.version}`,
            `Status: ${status.gateway}`,
            `Running version: ${status.runningVersion ?? "unavailable"}${status.runningBuildCommit === undefined ? "" : ` (${status.runningBuildCommit})`}`,
            `Version mismatch: ${status.versionMismatch ? "YES" : "no"}`,
            `Install mode: ${status.installMode}`,
            `Authority: ${status.authorityMode}`,
            `MCP: ${status.mcpEndpoint}`,
            `Owner Console: ${status.ownerConsoleUrl}`,
            `Paths: ${status.paths.length}`,
            `Commands: ${status.commands}`,
            `MCP Servers: ${status.mcpServersEnabled}/${status.mcpServers} enabled`,
            `Installed integrity: ${status.installedIntegrity}`,
            `Passphrase recovery: ${status.ownerPassphraseFile}`
          ].join("\n")
    );
    return true;
  }
  if (args[0] === "doctor") {
    const values = args.slice(1);
    onlyFlags(values, ["--json"]);
    const items = await runDoctor(management);
    output.write(
      values.includes("--json")
        ? JSON.stringify({ diagnostics: items })
        : items
            .map(
              (item) =>
                `[${item.level}] ${item.code}: ${item.message}${item.action === undefined ? "" : ` Next: ${item.action}`}`
            )
            .join("\n")
    );
    return true;
  }
  if (args[0] === "config") {
    const command = args[1];
    if (command === "show") {
      const values = args.slice(2);
      onlyFlags(values, ["--json"]);
      const config = await showProductConfig(management);
      output.write(
        values.includes("--json")
          ? JSON.stringify(config)
          : Object.entries(config)
              .map(
                ([key, value]) =>
                  `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`
              )
              .join("\n")
      );
      return true;
    }
    if (command === "set") {
      if (args.length !== 4) throw new Error("Usage: slnctrz-mcp config set <key> <value>");
      const key = args[2];
      if (key !== "port" && key !== "public-url" && key !== "owner-console" && key !== "host") {
        throw new Error("Unsupported config key");
      }
      const result = await setProductConfig(key, args[3] ?? "", management);
      output.write(
        `Configuration updated. Restart required: ${result.restartRequired ? "yes" : "no"}\n${JSON.stringify(result.config)}`
      );
      return true;
    }
    throw new Error(`Unknown config command: ${command ?? ""}`);
  }
  if (args[0] === "update") {
    const values = args.slice(1);
    only(values, ["--manifest"]);
    const result = await updateProduct(
      values.includes("--manifest") ? { manifestUrl: option(values, "--manifest") } : {},
      management
    );
    output.write(
      `Updated to ${result.activation.version}. Restart required: ${result.restartRequired ? "yes" : "no"}`
    );
    return true;
  }
  if (args[0] === "repair") {
    if (args.length !== 1) throw new Error("repair does not accept arguments");
    const result = await repairProduct(management);
    output.write(
      `Repair complete. Changes: ${result.changes.length === 0 ? "none" : result.changes.join(", ")}. Restart required: ${result.restartRequired ? "yes" : "no"}`
    );
    return true;
  }
  if (args[0] === "uninstall") {
    const values = args.slice(1);
    onlyFlags(values, ["--yes", "--remove-config", "--purge"]);
    if (!values.includes("--yes")) throw new Error("uninstall requires --yes confirmation");
    const result = await uninstallProduct(
      {
        removeConfig: values.includes("--remove-config") || values.includes("--purge"),
        purgeState: values.includes("--purge")
      },
      management
    );
    output.write(
      `Uninstall complete. Removed: ${result.removed.join(", ")}. State preserved: ${result.statePreserved ? "yes" : "no"}. Program removal deferred: ${result.deferredProgramRemoval ? "yes" : "no"}`
    );
    return true;
  }
  if (args[0] === "install") {
    const values = args.slice(1);
    only(values, ["--manifest", "--root"]);
    const manifest = await fetchReleaseManifest(option(values, "--manifest"), {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
    const activation = await installStandaloneRelease({
      installRoot: absolute(option(values, "--root")),
      manifest,
      target: currentReleaseTarget(),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
    output.write(JSON.stringify(activation));
    return true;
  }
  if (args[0] === "rollback") {
    const values = args.slice(1);
    if (values.length === 0) {
      const result = await rollbackProduct(management);
      output.write(
        `Rolled back to ${result.activation.version}. Restart required: ${result.restartRequired ? "yes" : "no"}`
      );
      return true;
    }
    only(values, ["--root"]);
    output.write(
      JSON.stringify(
        await rollbackStandaloneRelease({ installRoot: absolute(option(values, "--root")) })
      )
    );
    return true;
  }
  if (args[0] !== "owner") return false;

  const command = args[1];
  if (command === "rotate-passphrase") {
    if (args.length !== 2) throw new Error("owner rotate-passphrase does not accept arguments");
    const result = await rotateOwnerPassphrase(management);
    output.write(
      [
        "Owner Passphrase rotated.",
        `New Owner Passphrase: ${result.passphrase}`,
        `Stored at: ${result.recoveryFile}`,
        "Restart required: yes"
      ].join("\n")
    );
    return true;
  }
  if (command === "init") {
    const values = args.slice(2);
    only(values, ["--root", "--state-root"]);
    const root = absolute(option(values, "--root"));
    const stateRoot = values.includes("--state-root")
      ? absolute(option(values, "--state-root"))
      : (environment.SLNCTRZ_STATE_ROOT ?? managedStatePaths().root);
    const paths = managedStatePaths(stateRoot);
    await initializeDefaultWorkspace({ paths, root });
    output.write(JSON.stringify({ workspaceId: "default", root, policyFile: paths.policyFile }));
    return true;
  }
  const route =
    command === "status"
      ? "/status"
      : command === "policy"
        ? "/policy"
        : command === "reload"
          ? "/policy/reload"
          : undefined;
  if (route !== undefined && args.length === 2) {
    output.write(
      JSON.stringify(
        await ownerRequest(
          route,
          { method: command === "reload" ? "POST" : "GET" },
          environment,
          fetchImpl
        )
      )
    );
    return true;
  }
  throw new Error(`Unknown Owner command: ${command ?? ""}`);
}
