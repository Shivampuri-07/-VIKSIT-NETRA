/**
 * Configurable external data root (AEGIS_DATA_ROOT). Mirrors ml/data_root.py.
 *
 * The large original data (real SAR scene, labelled Radar_data, ERA5, AIS) is read from an external folder
 * and never copied into this repository. Resolution order for a relative path such as
 * "data/ais/2018/ais_2018-09-26_scene.csv":
 *   1. <AEGIS_DATA_ROOT>/<path>
 *   2. <AEGIS_DATA_ROOT>/<path> with the first segment's case swapped (the original tree uses "Data/")
 *   3. <project>/<path>
 * Nothing here hard-codes a user name or a machine path. The variable is read from the process
 * environment (server.ts loads the local .env into it).
 */

import fs from "fs";
import os from "os";
import path from "path";

export function dataRoot(): string | null {
  const raw = process.env.AEGIS_DATA_ROOT;
  if (!raw) return null;
  const p = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
  try {
    return fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

/** Existing file/dir for a relative data path, or null. */
export function resolveData(projectRoot: string, ...parts: string[]): string | null {
  const rel = path.join(...parts);
  const segs = rel.split(path.sep);
  const cands: string[] = [];
  const root = dataRoot();
  if (root) {
    cands.push(path.join(root, rel));
    if (segs[0] === "data" || segs[0] === "Data") {
      cands.push(path.join(root, segs[0] === "data" ? "Data" : "data", ...segs.slice(1)));
    }
  }
  cands.push(path.join(projectRoot, rel));
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

/** For status/health output: says whether an external root is configured without printing the path. */
export function dataRootStatus(): { configured: boolean; present: boolean } {
  return { configured: !!process.env.AEGIS_DATA_ROOT, present: dataRoot() !== null };
}
