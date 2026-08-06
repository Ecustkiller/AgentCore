import { HOST_CHANNELS } from "@shared/host-contract";
import { ipcMain } from "electron";
import { runHostOp } from "./dispatch";
import { err } from "./result";

export function registerHostIpc(): void {
  ipcMain.handle(HOST_CHANNELS.runOp, async (_event, raw: unknown) => {
    if (!raw || typeof raw !== "object") {
      return err("invalid host op input");
    }
    const o = raw as Record<string, unknown>;
    const op = typeof o.op === "string" ? o.op : "";
    const args =
      o.args && typeof o.args === "object" && !Array.isArray(o.args)
        ? (o.args as Record<string, unknown>)
        : {};
    return runHostOp({ op, args });
  });
}
