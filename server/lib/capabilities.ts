import fs from "fs";
import path from "path";

/** Honest status of every advanced capability (single source: ml/extensions/capabilities.json). */
export function loadCapabilities(root: string): any {
  const p = path.join(root, "ml", "extensions", "capabilities.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { schema: "aegis.capabilities.v1", capabilities: [], error: "ml/extensions/capabilities.json not found" };
  }
}
