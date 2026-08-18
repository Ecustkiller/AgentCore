import type { ProjectedTurn } from "@agentcore/protocol-conformance";
import { isTurnFixture } from "@agentcore/protocol-conformance/fixtureKind";

export interface PreviewFixture {
  name: string;
  description: string;
  /** Backend oracle final-state projection — preview renders this, no client fold. */
  projected: ProjectedTurn;
}

interface RawFixture {
  name: string;
  description?: string;
  projected: ProjectedTurn;
}

// Same committed vectors as mobile `#/preview`. ChatView reads `projected` only.
const modules = import.meta.glob(
  "../../../../packages/protocol-conformance/fixtures/*.json",
  { eager: true },
) as Record<string, { default: RawFixture }>;

export const PREVIEW_FIXTURES: PreviewFixture[] = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, mod]) => mod.default)
  .filter(isTurnFixture)
  .map((fx) => ({
    name: fx.name,
    description: fx.description ?? "",
    projected: fx.projected,
  }));
