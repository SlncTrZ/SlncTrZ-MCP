/** Canonical runtime build identity derived from package metadata plus optional build provenance. */

import pkg from "../../package.json" with { type: "json" };

export const APP_VERSION: string = pkg.version;

/**
 * Build commit injected by CI/deployment. Keep `unknown` explicit rather than fabricating provenance.
 */
export const BUILD_COMMIT: string = process.env.SLNCTRZ_BUILD_COMMIT?.trim() || "unknown";
