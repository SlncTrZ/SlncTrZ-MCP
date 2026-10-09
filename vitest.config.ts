import { defineConfig, type VitestConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/conformance/**/*.test.ts"],
    globals: false,
    environment: "node",
    // Bound native ACL/process fixture contention on Windows without changing product deadlines.
    maxWorkers: process.platform === "win32" ? 2 : undefined,
    testTimeout: process.platform === "win32" ? 15_000 : 5_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"]
    }
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  }
} satisfies VitestConfig);
