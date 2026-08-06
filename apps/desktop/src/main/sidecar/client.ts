import type { Transport } from "./transport";

// --- JSON-RPC 客户端 ---

/** 一个 JSON-RPC 错误响应（携带服务端的 code/message）。 */
export class SidecarRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "SidecarRpcError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * stdio JSON-RPC 客户端（行分帧）。与 Python 端 `agentcore/sidecar/protocol.py` 对齐：
 * 一行一个 JSON，紧凑序列化 + `\n` 结尾。请求按 id 配对；服务端只回响应与通知
 * （无服务端→客户端请求），故通知统一交给 `onNotification`。
 */
export class SidecarClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private notify: (method: string, params: Record<string, unknown>) => void =
    () => {};
  private closed = false;
  private closeErr: Error | null = null;
  private onClosedCb: ((err: Error) => void) | null = null;

  constructor(private readonly transport: Transport) {
    transport.onLine((line) => this.onLine(line));
    transport.onClose((err) => this.onClose(err));
  }

  /** 注册通知处理器（如 `turn/event`）。 */
  onNotification(
    cb: (method: string, params: Record<string, unknown>) => void,
  ): void {
    this.notify = cb;
  }

  /** 注册「连接关闭」回调（进程退出 / 出错）；用于上层逐出缓存并提示。 */
  onClosed(cb: (err: Error) => void): void {
    this.onClosedCb = cb;
  }

  /** 发一个请求，Promise 在收到对应响应时 settle（错误响应 → reject `SidecarRpcError`）。 */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(this.closeErr ?? new Error("sidecar 已关闭"));
    }
    const id = this.nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.send(line);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  dispose(): void {
    this.transport.close();
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return; // 非法行——丢弃（日志走 stderr，不会混进这条通道）
    }

    const id = msg.id;
    if (typeof id === "number" && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if ("error" in msg) {
        const err = msg.error as
          | { code?: number; message?: string }
          | undefined;
        p.reject(
          new SidecarRpcError(err?.code ?? -1, err?.message ?? "sidecar 错误"),
        );
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method === "string") {
      this.notify(msg.method, (msg.params as Record<string, unknown>) ?? {});
    }
  }

  private onClose(err?: Error): void {
    this.closed = true;
    this.closeErr = err ?? new Error("sidecar 进程已退出");
    for (const [, p] of this.pending) p.reject(this.closeErr);
    this.pending.clear();
    this.onClosedCb?.(this.closeErr);
  }
}
