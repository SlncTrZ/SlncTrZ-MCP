/**
 * Application Entry — dispatches standalone CLI commands before gateway bootstrap.
 * Signal handlers live only in this executable boundary; importing app modules has no global
 * lifecycle side effects.
 */

import { runApplication } from "./application-runner.js";
import type { ApplicationLifecycle } from "./main.js";

let lifecycle: ApplicationLifecycle | undefined;
let pendingSignal: NodeJS.Signals | undefined;
let shutdownPromise: Promise<void> | undefined;

const removeSignalHandlers = (): void => {
  process.off("SIGTERM", onSigterm);
  process.off("SIGINT", onSigint);
};

const requestShutdown = (signal: NodeJS.Signals): Promise<void> => {
  pendingSignal ??= signal;
  if (lifecycle === undefined) return Promise.resolve();
  shutdownPromise ??= lifecycle.shutdown().finally(() => {
    removeSignalHandlers();
  });
  return shutdownPromise;
};

const onSigterm = (): void => {
  void requestShutdown("SIGTERM");
};
const onSigint = (): void => {
  void requestShutdown("SIGINT");
};

process.once("SIGTERM", onSigterm);
process.once("SIGINT", onSigint);

void (async () => {
  try {
    lifecycle = await runApplication(process.argv.slice(2));
    if (lifecycle === undefined) {
      removeSignalHandlers();
      return;
    }
    if (pendingSignal !== undefined) {
      await requestShutdown(pendingSignal);
    }
  } catch (error) {
    removeSignalHandlers();
    console.error(error instanceof Error ? error.message : "Standalone command failed");
    process.exitCode = 1;
  }
})();
