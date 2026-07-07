import type { SSEEvent } from "@/types/events";
import { isTurnFixture } from "@agentcore/protocol-conformance/fixtureKind";

export interface PreviewFixture {
  name: string;
  description: string;
  events: SSEEvent[];
}

// Every committed turn-fold conformance vector doubles as a preview scenario.
// Auxiliary blobs (region positions, simulation fold goldens) are excluded — same
// contract as protocol-conformance harness `isTurnFixture`.
const modules = import.meta.glob(
  "../../../../../packages/protocol-conformance/fixtures/*.json",
  { eager: true },
) as Record<string, { default: unknown }>;

export const PREVIEW_FIXTURES: PreviewFixture[] = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, mod]) => mod.default)
  .filter(isTurnFixture)
  .map((fx) => ({
    name: fx.name,
    description: fx.description ?? "",
    events: fx.events,
  }));
