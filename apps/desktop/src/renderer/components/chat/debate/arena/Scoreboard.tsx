import { Button } from "@/components/ui";
import { useDebateTake, useDebateUserTake } from "@/stores/debateUserTake";
import { Hand } from "lucide-react";
import { ModelBadge } from "../ModelBadge";
import {
  type DebateModel,
  type DebateScoreView,
  debateRoster,
  debateSideColorVar,
  modelVendorLabel,
  stopLabel,
  tallyScores,
} from "../model";
import {
  RISK_LEVELS,
  RISK_SEVERITY,
  buildRiskItems,
  riskCounts,
} from "../severity";
import { HowToReadPopover } from "./HowToReadPopover";
import { MomentumChart } from "./MomentumChart";
import {
  closingAnchorId,
  finaleAnchorId,
  roundAnchorId,
  steeringAnchorId,
} from "./anchors";
import {
  DEBATE_ARENA_PAGE_MAX,
  type DebateArenaLayout,
} from "./debateLayoutPreference";

export function Scoreboard({
  model,
  messageId,
  hasPendingSteering,
  onScrollTo,
  canSplit,
  layoutMode,
  onLayoutChange,
}: {
  model: DebateModel;
  messageId: string;
  hasPendingSteering: boolean;
  onScrollTo: (anchorId: string) => void;
  canSplit?: boolean;
  layoutMode?: DebateArenaLayout;
  onLayoutChange?: (mode: DebateArenaLayout) => void;
}) {
  const motion = model.motion ?? model.rounds[0]?.focus ?? "辩论";
  const tally = model.form === "roundtable" ? [] : tallyScores(model.rounds);
  const roster = debateRoster(model.rounds);
  const isVersus = model.form === "debate" && roster.length === 2;
  const liveRound = model.rounds.find((r) => r.inFlight);
  const currentRoundNo = liveRound?.roundNo ?? model.rounds.length;
  const totalRounds = model.rounds.length;

  const chapters: { id: string; label: string }[] = model.rounds.map((r) => ({
    id: roundAnchorId(r.roundNo),
    label: `第${r.roundNo}轮`,
  }));
  if (model.settled && model.closings.length > 0) {
    chapters.push({ id: closingAnchorId(), label: "结辩" });
  }
  if (model.settled) {
    chapters.push({ id: finaleAnchorId(), label: "终审" });
  }

  return (
    <div className="border-b border-border">
      <div className={`mx-auto ${DEBATE_ARENA_PAGE_MAX} px-1 py-3`}>
        <div className="flex items-start gap-2">
          <p
            className="min-w-0 flex-1 truncate text-base font-medium text-foreground"
            title={motion}
          >
            {motion}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {hasPendingSteering && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => onScrollTo(steeringAnchorId())}
                icon={<Hand size={13} />}
              >
                等你掌舵
              </Button>
            )}
            <StatusLine
              model={model}
              liveRound={liveRound}
              currentRoundNo={currentRoundNo}
              totalRounds={totalRounds}
            />
            <HowToReadPopover form={model.form} />
          </div>
        </div>

        <div className="mt-2">
          <ScoreboardRow2
            model={model}
            tally={tally}
            roster={roster}
            isVersus={isVersus}
            messageId={messageId}
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {canSplit && layoutMode && onLayoutChange && (
            <LayoutToggle mode={layoutMode} onChange={onLayoutChange} />
          )}
          <MomentumChart
            rounds={model.rounds}
            sideKeys={roster.map((r) => r.sideKey)}
            colorByKey={Object.fromEntries(
              roster.map((r) => [
                r.sideKey,
                debateSideColorVar(r.sideKey, r.name),
              ]),
            )}
          />
          <div className="flex flex-1 flex-wrap gap-1">
            {chapters.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onScrollTo(c.id)}
                className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusLine({
  model,
  liveRound,
  currentRoundNo,
  totalRounds,
}: {
  model: DebateModel;
  liveRound: DebateModel["rounds"][number] | undefined;
  currentRoundNo: number;
  totalRounds: number;
}) {
  if (model.settled) {
    return (
      <span className="shrink-0 text-xs text-muted-foreground">
        {stopLabel(model.stopReason)}
      </span>
    );
  }

  const speaking = liveRound?.sides.find((s) => s.run?.status === "running");
  const phase = speaking
    ? `${speaking.name}正在${currentRoundNo <= 1 ? "立论" : "续辩"}`
    : liveRound?.crossExam.length
      ? "质询进行中"
      : `第 ${currentRoundNo}/${totalRounds} 轮`;

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-1.5 animate-pulse rounded-full bg-primary" />
      {phase}
    </span>
  );
}

function ScoreboardRow2({
  model,
  tally,
  roster,
  isVersus,
  messageId,
}: {
  model: DebateModel;
  tally: DebateScoreView[];
  roster: ReturnType<typeof debateRoster>;
  isVersus: boolean;
  messageId: string;
}) {
  if (model.form === "roundtable" && model.sides) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        {model.sides.map((s) => (
          <span
            key={s.key}
            className="inline-flex items-center gap-1.5 text-sm text-foreground"
          >
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: debateSideColorVar(s.key, s.name) }}
            />
            {s.name}
          </span>
        ))}
      </div>
    );
  }

  if (model.form === "red_team" && model.sides) {
    const subject = model.sides.find((s) => s.is_subject);
    const risks = model.brief ? buildRiskItems(model.sides, model.brief) : [];
    const counts = riskCounts(risks);
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {subject && (
            <span>
              <span className="text-muted-foreground">方案方 </span>
              <span className="font-medium">{subject.name}</span>
            </span>
          )}
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            红队 {roster.filter((r) => r.sideKey !== subject?.key).length} 人
          </span>
        </div>
        {model.settled && (
          <div className="flex gap-1">
            {RISK_LEVELS.filter((l) => counts[l] > 0).map((l) => (
              <span key={l} className={RISK_SEVERITY[l].pill}>
                {RISK_SEVERITY[l].label} {counts[l]}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (isVersus && tally.length >= 2 && model.sides) {
    const [a, b] = tally;
    const proSide = model.sides.find((s) => s.stance === "pro");
    const conSide = model.sides.find((s) => s.stance === "con");
    const proRoster = proSide
      ? roster.find((r) => r.sideKey === proSide.key)
      : roster[0];
    const conRoster = conSide
      ? roster.find((r) => r.sideKey === conSide.key)
      : roster[1];
    const proKey = proSide?.key ?? proRoster?.sideKey ?? a.sideKey;
    const conKey = conSide?.key ?? conRoster?.sideKey ?? b.sideKey;
    const proModel = sideRunModel(model, proKey);
    const conModel = sideRunModel(model, conKey);
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <VersusSide
          name={proRoster?.name ?? a.name}
          model={proModel}
          colorVar={debateSideColorVar(
            proRoster?.sideKey ?? a.sideKey,
            proRoster?.name ?? a.name,
          )}
          align="left"
        />
        <span className="text-xl font-semibold tabular-nums text-foreground">
          {a.total} ： {b.total}
        </span>
        <VersusSide
          name={conRoster?.name ?? b.name}
          model={conModel}
          colorVar={debateSideColorVar(
            conRoster?.sideKey ?? b.sideKey,
            conRoster?.name ?? b.name,
          )}
          align="right"
        />
        <StanceControl turnId={messageId} model={model} />
      </div>
    );
  }

  return null;
}

/** 从各轮发言格取某方的实际执行 model（run.model），忽略 roster 声称的 per-side model。 */
function sideRunModel(model: DebateModel, sideKey: string): string | undefined {
  for (const round of model.rounds) {
    const side = round.sides.find((s) => s.sideKey === sideKey);
    if (side?.model) return side.model;
  }
  return undefined;
}

function VersusSide({
  name,
  model,
  colorVar,
  align,
}: {
  name: string;
  model?: string;
  colorVar: string;
  align: "left" | "right";
}) {
  const vendor = modelVendorLabel(model);
  return (
    <div
      className={`flex min-w-0 items-center gap-2 text-sm ${align === "right" ? "flex-row-reverse text-right" : ""}`}
    >
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: colorVar }}
      />
      <span className="font-medium text-foreground">{name}</span>
      {vendor && <ModelBadge model={model ?? ""} />}
    </div>
  );
}

function LayoutToggle({
  mode,
  onChange,
}: {
  mode: DebateArenaLayout;
  onChange: (mode: DebateArenaLayout) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <span className="text-xs text-muted-foreground">布局</span>
      <div className="flex rounded-lg border border-border p-0.5">
        {(
          [
            { key: "split" as const, label: "并排" },
            { key: "stack" as const, label: "单栏" },
          ] as const
        ).map(({ key, label }) => {
          const active = mode === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(key)}
              className={`rounded-lg px-2 py-0.5 text-xs font-medium transition-colors ${
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StanceControl({
  turnId,
  model,
}: {
  turnId: string;
  model: DebateModel;
}) {
  const stance = useDebateTake(turnId).stance;
  const setStance = useDebateUserTake((s) => s.setStance);
  const proSideInfo = model.sides?.find((s) => s.stance === "pro");
  const conSideInfo = model.sides?.find((s) => s.stance === "con");
  if (!proSideInfo || !conSideInfo) return null;

  return (
    <div className="flex w-full items-center gap-1 sm:ml-auto sm:w-auto">
      <span className="text-xs text-muted-foreground">你站</span>
      <div className="flex rounded-lg border border-border p-0.5">
        {[
          { key: proSideInfo.key, label: "正方" },
          { key: conSideInfo.key, label: "反方" },
        ].map(({ key, label }) => {
          const active = stance === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => setStance(turnId, active ? null : key)}
              className={`rounded-lg px-2 py-0.5 text-xs font-medium transition-colors ${
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
