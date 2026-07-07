type DebugCategory = "spawn" | "asset" | "anim" | "lod";

function isEnabled(category: DebugCategory): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof localStorage === "undefined") return false;
  const key = localStorage.getItem("simTownDebug");
  if (!key) return false;
  return key === "all" || key === category;
}

function log(
  category: DebugCategory,
  event: string,
  data?: Record<string, unknown>,
): void {
  if (!isEnabled(category)) return;
  if (data !== undefined) {
    console.log(`[sim/town] ${event}`, data);
  } else {
    console.log(`[sim/town] ${event}`);
  }
}

/** Dev-only structured logging for town rendering (localStorage `simTownDebug`). */
export const townRenderDebug = {
  assetLoaded: (data: Record<string, unknown>) =>
    log("asset", "asset:loaded", data),
  assetClone: (data: Record<string, unknown>) =>
    log("asset", "asset:clone", data),
  spawnInit: (data: Record<string, unknown>) =>
    log("spawn", "spawn:init", data),
  animBind: (data: Record<string, unknown>) => log("anim", "anim:bind", data),
  lodChange: (data: Record<string, unknown>) => log("lod", "lod:change", data),
  warnBounds: (data: Record<string, unknown>) =>
    log("asset", "warn:bounds", data),
};
