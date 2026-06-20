// Desktop ↔ backend protocol 巡检 (手机端落地设计 §六; protocol-conformance.mdc).
//
// Pins desktop's fold (conformanceFold.ts — reusing the REAL projectExecution) to the
// SAME backend-exported golden the mobile fold is checked against. If desktop's team-
// graph projection drifts from the protocol, these assertions go red — which is the
// whole point: two front-ends, one oracle, no silent divergence.
//
// The golden JSON is imported directly (resolveJsonModule) rather than read via fs so
// the desktop test stays free of @types/node and runs under the existing vitest config.
// When the backend ratchet adds/removes a vector, update this import list to match
// (`apps/server/agentcore/conformance/vectors.py` → `pnpm conformance` exports them).

import type { SSEEvent } from "@/types/events";
import { describe, expect, it } from "vitest";
import { type ProjectedTurn, foldToProjectedTurn } from "../conformanceFold";

import approvalPaused from "../../../../../../packages/protocol-conformance/fixtures/approval_paused.json";
import approvalResolvedContinue from "../../../../../../packages/protocol-conformance/fixtures/approval_resolved_continue.json";
import multiAgentDebate from "../../../../../../packages/protocol-conformance/fixtures/multi_agent_debate.json";
import multiAgentDelegate from "../../../../../../packages/protocol-conformance/fixtures/multi_agent_delegate.json";
import multiAgentMultiBatch from "../../../../../../packages/protocol-conformance/fixtures/multi_agent_multi_batch.json";
import multiAgentRevision from "../../../../../../packages/protocol-conformance/fixtures/multi_agent_revision.json";
import multiAgentRoundtableRounds from "../../../../../../packages/protocol-conformance/fixtures/multi_agent_roundtable_rounds.json";
import multiAgentWorkerTool from "../../../../../../packages/protocol-conformance/fixtures/multi_agent_worker_tool.json";
import planReviewPaused from "../../../../../../packages/protocol-conformance/fixtures/plan_review_paused.json";
import planReviewResolvedContinue from "../../../../../../packages/protocol-conformance/fixtures/plan_review_resolved_continue.json";
import singleAgentCitations from "../../../../../../packages/protocol-conformance/fixtures/single_agent_citations.json";
import singleAgentContentReset from "../../../../../../packages/protocol-conformance/fixtures/single_agent_content_reset.json";
import singleAgentError from "../../../../../../packages/protocol-conformance/fixtures/single_agent_error.json";
import singleAgentText from "../../../../../../packages/protocol-conformance/fixtures/single_agent_text.json";
import singleAgentTool from "../../../../../../packages/protocol-conformance/fixtures/single_agent_tool.json";

interface Fixture {
  name: string;
  description: string;
  events: SSEEvent[];
  projected: ProjectedTurn;
}

const fixtures = [
  singleAgentText,
  singleAgentTool,
  singleAgentError,
  singleAgentCitations,
  singleAgentContentReset,
  multiAgentDelegate,
  multiAgentWorkerTool,
  multiAgentDebate,
  multiAgentRoundtableRounds,
  multiAgentRevision,
  multiAgentMultiBatch,
  approvalPaused,
  approvalResolvedContinue,
  planReviewPaused,
  planReviewResolvedContinue,
] as unknown as Fixture[];

describe("desktop fold ↔ backend golden (protocol conformance)", () => {
  for (const fx of fixtures) {
    it(`${fx.name} — ${fx.description}`, () => {
      expect(foldToProjectedTurn(fx.events)).toEqual(fx.projected);
    });
  }
});
