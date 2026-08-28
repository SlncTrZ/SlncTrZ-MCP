/**
 * Application Entry — dispatches standalone CLI commands before gateway bootstrap.
 * Wing: app | Topic: process-entrypoint | Updated: 2026-08-28
 *
 * Provenance: PLAN Phase 8 and ADR-008.
 */

import { runApplication } from "./application-runner.js";

void runApplication(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Standalone command failed");
  process.exitCode = 1;
});
