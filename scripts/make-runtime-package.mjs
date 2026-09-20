/**
 * Emits a minimal package.json for the RUNTIME container stage.
 *
 * `npm ci --omit=dev` still installs ~320 MB, because the React/PDF/chart packages are listed as
 * dependencies (Vite needs them at build time) even though Vite compiles them into dist/ and the
 * server never requires them. The compiled server bundle (dist-server/server.cjs) requires only:
 *
 *   express                 the HTTP layer (the sole static require in the bundle)
 *   @langchain/langgraph    loaded through a dynamic import(), so esbuild leaves it external;
 *   @langchain/core         without it the orchestrator falls back to DETERMINISTIC_FALLBACK and
 *                           labels itself as such, which would understate what the project does
 *
 * Versions are copied from package.json, so this file cannot drift from the tested set.
 *   node scripts/make-runtime-package.mjs > package.runtime.json
 */
import fs from "fs";

const RUNTIME_DEPS = ["express", "@langchain/langgraph", "@langchain/core"];

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const dependencies = {};
const missing = [];
for (const name of RUNTIME_DEPS) {
  const version = pkg.dependencies?.[name];
  if (version) dependencies[name] = version;
  else missing.push(name);
}
if (missing.length) {
  console.error(`[runtime-package] not found in package.json dependencies: ${missing.join(", ")}`);
  process.exit(1);
}

process.stdout.write(
  JSON.stringify(
    {
      name: "viksit-netra-runtime",
      private: true,
      version: pkg.version ?? "0.0.0",
      description: "Runtime-only dependencies for the VIKSIT-NETRA production container.",
      dependencies,
    },
    null,
    2,
  ) + "\n",
);
