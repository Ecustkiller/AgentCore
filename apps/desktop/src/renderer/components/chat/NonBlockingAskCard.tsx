import { ResolvedDecisionRecord } from "@/components/chat/decision";
import type { NonBlockingAskDisplay } from "@/stores/conversation";
import { Ban, Check } from "lucide-react";

export function NonBlockingAskCard({ ask }: { ask: NonBlockingAskDisplay }) {
  if (ask.status !== "resolved") return null;

  const discarded = ask.settlement === "discarded";
  const label = discarded ? "已作废" : "已答";
  const body = discarded ? ask.note : ask.answer;

  return (
    <div data-ask-status="resolved" data-ask-settlement={ask.settlement ?? ""}>
      <ResolvedDecisionRecord
        layout="toneStub"
        disclosureKey={ask.id ? `${ask.id}:resolved` : null}
        tone={discarded ? "muted" : "success"}
        icon={discarded ? Ban : Check}
        label={label}
        collapsedSummary={body}
      >
        <div className="space-y-1.5 pb-3 pl-10 pr-3">
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {ask.question}
          </p>
          {ask.context && (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">
              {ask.context}
            </p>
          )}
          {body ? (
            <p className="whitespace-pre-wrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-foreground">
              {body}
            </p>
          ) : null}
        </div>
      </ResolvedDecisionRecord>
    </div>
  );
}
