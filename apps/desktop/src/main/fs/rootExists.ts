import { stat } from "node:fs/promises";

/** Host-side directory liveness. Missing / not-a-dir / empty path → false. */
export async function isExistingDirectory(absPath: string): Promise<boolean> {
  const path = absPath.trim();
  if (!path) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
