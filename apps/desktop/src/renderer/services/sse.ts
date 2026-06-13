const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export interface SSEEvent {
  type: string;
  execution_id: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

type EventHandler = (event: SSEEvent) => void;

export class SSEConnection {
  private eventSource: EventSource | null = null;
  private handlers: Map<string, EventHandler[]> = new Map();

  connect(conversationId: string): void {
    this.disconnect();

    const url = `${BASE_URL}/v1/conversations/${conversationId}/stream`;
    this.eventSource = new EventSource(url, { withCredentials: true });

    this.eventSource.onmessage = (event) => {
      try {
        const parsed: SSEEvent = JSON.parse(event.data);
        this.dispatch(parsed);
      } catch {
        // ignore malformed events
      }
    };

    this.eventSource.onerror = () => {
      // reconnection is handled by EventSource natively
    };
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }

  on(eventType: string, handler: EventHandler): () => void {
    const handlers = this.handlers.get(eventType) ?? [];
    handlers.push(handler);
    this.handlers.set(eventType, handlers);

    return () => {
      const current = this.handlers.get(eventType) ?? [];
      this.handlers.set(
        eventType,
        current.filter((h) => h !== handler),
      );
    };
  }

  private dispatch(event: SSEEvent): void {
    const handlers = this.handlers.get(event.type) ?? [];
    for (const handler of handlers) {
      handler(event);
    }
    const wildcardHandlers = this.handlers.get("*") ?? [];
    for (const handler of wildcardHandlers) {
      handler(event);
    }
  }
}

export const sseConnection = new SSEConnection();
