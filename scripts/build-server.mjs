/**
 * Bundles the Express server into dist-server/ (NOT dist/, which is served
 * publicly). The bundle is marked as a production build, so `node
 * dist-server/server.cjs` always runs in production mode and never starts
 * the Vite dev server. npm packages stay external (installed node_modules).
 */
import { build } from "esbuild";

await build({
  entryPoints: ["server.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  packages: "external",
  sourcemap: true,
  outfile: "dist-server/server.cjs",
  define: { __AEGIS_BUILD__: '"production"' },
  logLevel: "info",
});
