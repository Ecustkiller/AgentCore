import type { SSEEvent } from "@agentcore/contract-types";
import { BASE_URL, notifyUnauthorized, tryRefresh } from "@/services/api";
import { dispatchSimulationEvent } from "@/services/sse/handlers/simulation";
import { useSimulationUiStore } from "@/simulation/store/simulationStore";

let controller: AbortController | null = null;
let activeRunId: string | null = null;

function parseFrame(frame: string): SSEEvent | null {
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n")) as SSEEvent;
  } catch {
    return null;
  }
}

async function pumpSimulationStream(
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  const url = `${BASE_URL}/v1/simulation/runs/${encodeURIComponent(runId)}/stream`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/event-stream" },
      signal,
    });
  } catch {
    useSimulationUiStore
      .getState()
      .setStreamStatus("error", "无法连接模拟 SSE 流");
    return;
  }

  if (response.status === 401) {
    if (await tryRefresh()) {
      return pumpSimulationStream(runId, signal);
    }
    notifyUnauthorized();
    useSimulationUiStore.getState().setStreamStatus("error", "未登录");
    return;
  }

  if (!response.ok || !response.body) {
    useSimulationUiStore
      .getState()
      .setStreamStatus("error", `SSE 连接失败 (${response.status})`);
    return;
  }

  useSimulationUiStore.getState().setStreamStatus("connected");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = parseFrame(frame);
        if (event) dispatchSimulationEvent(event, { runId });
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    useSimulationUiStore
      .getState()
      .setStreamStatus(
        "error",
        err instanceof Error ? err.message : "SSE 中断",
      );
    return;
  }

  if (!signal.aborted) {
    useSimulationUiStore.getState().setStreamStatus("idle");
  }
}

/** Connect (or reconnect) to a simulation run SSE stream. */
export function connectSimulationStream(runId: string): void {
  if (activeRunId === runId && controller) return;
  disconnectSimulationStream();
  activeRunId = runId;
  controller = new AbortController();
  useSimulationUiStore.getState().setStreamStatus("connecting");
  void pumpSimulationStream(runId, controller.signal);
}

export function disconnectSimulationStream(): void {
  controller?.abort();
  controller = null;
  activeRunId = null;
  useSimulationUiStore.getState().setStreamStatus("idle");
}
