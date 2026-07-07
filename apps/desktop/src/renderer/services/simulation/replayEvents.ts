import { BASE_URL } from "@/services/api";
import { formatSimEventSummary } from "@/simulation/simEventFormat";
import type { SimStreamEvent } from "@/simulation/store/simulationStore";
import type { SSEEvent, SimWorldEventPayload } from "@agentcore/contract-types";

function parseSseBody(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const frame of text.split("\n\n")) {
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (dataLines.length === 0) continue;
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as SSEEvent;
      if (parsed.type) events.push(parsed);
    } catch {
      /* skip malformed frames */
    }
  }
  return events;
}

function toSimStreamEvent(
  event: SSEEvent,
  index: number,
): SimStreamEvent | null {
  if (!event.type.startsWith("sim.")) return null;
  if (event.type === "sim.tick_frame") return null;

  const tick =
    typeof (event.payload as { tick?: number }).tick === "number"
      ? (event.payload as { tick: number }).tick
      : typeof (event.payload as { tick_number?: number }).tick_number ===
          "number"
        ? (event.payload as { tick_number: number }).tick_number
        : 0;

  const { agentId, summary } = formatSimEventSummary(event.type, event.payload);
  const worldEvent =
    event.type === "sim.world_event"
      ? (event.payload as SimWorldEventPayload).event
      : undefined;
  const modifiers =
    event.type === "sim.world_event"
      ? (event.payload as SimWorldEventPayload).modifiers
      : undefined;
  return {
    id: `replay-ev-${index}`,
    tick,
    type: event.type,
    agentId,
    summary,
    timestamp: event.timestamp,
    worldEvent,
    modifiers,
  };
}

/** Fetch persisted sim events from GET /replay (BE-28 SSE stream). */
export async function fetchReplayEvents(
  runId: string,
  fromTick: number,
  toTick: number,
): Promise<SimStreamEvent[]> {
  const url = `${BASE_URL}/v1/simulation/runs/${encodeURIComponent(runId)}/replay?from=${fromTick}&to=${toTick}`;
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok) {
    throw new Error(`回放加载失败 (${response.status})`);
  }
  const text = await response.text();
  const wire = parseSseBody(text);
  const out: SimStreamEvent[] = [];
  let seq = 0;
  for (const event of wire) {
    const mapped = toSimStreamEvent(event, seq);
    seq += 1;
    if (mapped) out.push(mapped);
  }
  return out;
}
