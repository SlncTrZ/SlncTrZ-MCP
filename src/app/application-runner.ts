/**
 * Application Runner — testable CLI-to-bootstrap delegation without import side effects.
 * Wing: app | Topic: application-dispatch | Updated: 2026-08-28
 *
 * Provenance: PLAN Phase 8 and ADR-008.
 */

import { bootstrap } from "./main.js";
import { runStandaloneCli } from "./standalone-cli.js";
import {
  applyInstalledRuntimeEnvironment,
  runInstalledLauncherIfNeeded
} from "../standalone/installed-runtime.js";

export interface ApplicationDependencies {
  readonly runCli: typeof runStandaloneCli;
  readonly bootstrap: typeof bootstrap;
}

const DEFAULT_DEPENDENCIES: ApplicationDependencies = {
  runCli: runStandaloneCli,
  bootstrap
};

/** Dispatch an explicit standalone command or start the normal gateway runtime. */
export async function runApplication(
  args: readonly string[],
  dependencies: ApplicationDependencies = DEFAULT_DEPENDENCIES
): Promise<void> {
  if (await runInstalledLauncherIfNeeded(args)) return;
  if (!(await dependencies.runCli(args))) {
    await applyInstalledRuntimeEnvironment();
    await dependencies.bootstrap();
  }
}
