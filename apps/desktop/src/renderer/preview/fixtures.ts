import type { SSEEvent } from "@/types/events";

export interface PreviewFixture {
  name: string;
  description: string;
  events: SSEEvent[];
}

interface RawFixture {
  name: string;
  description: string;
  events: SSEEvent[];
}

// Every committed conformance vector doubles as a preview scenario. They are the
// backend-exported golden event streams (single source: agentcore.conformance.export)
// that gate `pnpm conformance`; replaying them through the real SSE dispatch
// reproduces each AI state offline, and they can never drift from production
// because the same files are the protocol oracle. Drop a new fixture JSON into the
// package and it shows up here automatically.
const modules = import.meta.glob(
  "../../../../../packages/protocol-conformance/fixtures/*.json",
  { eager: true },
) as Record<string, { default: RawFixture }>;

export const PREVIEW_FIXTURES: PreviewFixture[] = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, mod]) => ({
    name: mod.default.name,
    description: mod.default.description,
    events: mod.default.events,
  }));
