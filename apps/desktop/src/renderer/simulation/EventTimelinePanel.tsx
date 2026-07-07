import {
  type ActiveInteraction,
  tradeBriefLabel,
  voteGovernanceDetails,
} from "@/simulation/interactionModel";
import { SIM_EVENT_LABELS } from "@/simulation/simEventFormat";
import { useSimulationUiStore } from "@/simulation/store/simulationStore";
import {
  TOWN_AGENT_IDS,
  TOWN_AGENT_NAMES,
  type TownAgentId,
} from "@/simulation/town/townRoster";
import { useSimulationView } from "@/simulation/viewState";
import type { InteractionResult } from "@agentcore/contract-types";
import {
  ChevronDown,
  ChevronRight,
  Coins,
  MessageCircle,
  Vote,
} from "lucide-react";
import { useMemo, useState } from "react";

function agentLabel(agentId: string | undefined): string | null {
  if (!agentId) return null;
  return TOWN_AGENT_NAMES[agentId as TownAgentId] ?? agentId;
}

function interactionKindLabel(kind: InteractionResult["kind"]): string {
  switch (kind) {
    case "conversation":
      return "对话";
    case "trade":
      return "交易";
    case "vote":
      return "投票";
    default:
      return kind;
  }
}

function InteractionKindIcon({
  kind,
}: {
  kind: InteractionResult["kind"];
}) {
  const className = "h-3.5 w-3.5 shrink-0";
  switch (kind) {
    case "conversation":
      return <MessageCircle className={className} aria-hidden />;
    case "trade":
      return <Coins className={className} aria-hidden />;
    case "vote":
      return <Vote className={className} aria-hidden />;
    default:
      return null;
  }
}

function InteractionEventDetails({
  interaction,
}: {
  interaction: InteractionResult;
}) {
  switch (interaction.kind) {
    case "conversation":
      return (
        <ul className="mt-1.5 space-y-1 border-t border-border/60 pt-1.5">
          {(interaction.transcript ?? []).map((line, index) => (
            <li
              key={`${line.speaker_id}-${line.round}-${index}`}
              className="text-xs"
            >
              <span className="font-medium text-foreground">
                {line.speaker_name || agentLabel(line.speaker_id)}：
              </span>{" "}
              <span className="text-muted-foreground">{line.text}</span>
            </li>
          ))}
          {(interaction.transcript ?? []).length === 0 ? (
            <li className="text-xs text-muted-foreground">
              {interaction.summary}
            </li>
          ) : null}
        </ul>
      );
    case "trade": {
      const active: ActiveInteraction = {
        id: interaction.request_id,
        tick: 0,
        kind: "trade",
        status: interaction.status,
        initiatorId: interaction.initiator_id,
        targetId: interaction.target_id,
        summary: interaction.summary,
        stateChanges: interaction.state_changes,
        detail: interaction.detail,
        expiresAt: 0,
      };
      return (
        <div className="mt-1.5 space-y-1 border-t border-border/60 pt-1.5 text-xs text-muted-foreground">
          <p>
            <span className="text-foreground">明细：</span>
            {tradeBriefLabel(active)}
          </p>
          <p>
            <span className="text-foreground">状态：</span>
            {interaction.status === "completed" ? "成交" : "未成交"}
          </p>
          {interaction.detail ? <p>{interaction.detail}</p> : null}
        </div>
      );
    }
    case "vote": {
      const { motion, outcome, yes, no, abstain } = voteGovernanceDetails(
        interaction.state_changes,
      );
      return (
        <div className="mt-1.5 space-y-1 border-t border-border/60 pt-1.5 text-xs text-muted-foreground">
          {motion ? (
            <p>
              <span className="text-foreground">议题：</span>
              {motion}
            </p>
          ) : null}
          <p>
            支持 {yes} · 反对 {no} · 弃权 {abstain}
          </p>
          {outcome ? (
            <p>
              <span className="text-foreground">结果：</span>
              {outcome}
            </p>
          ) : null}
          {(interaction.transcript ?? []).length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {interaction.transcript!.map((line, index) => (
                <li key={`${line.speaker_id}-${index}`}>
                  {line.speaker_name}：{line.text}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    }
    default:
      return null;
  }
}

export function EventTimelinePanel() {
  const { viewEvents } = useSimulationView();
  const run = useSimulationUiStore((s) => s.run);
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [expandedTicks, setExpandedTicks] = useState<Set<number>>(
    () => new Set(),
  );
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(
    () => new Set(),
  );

  const filtered = useMemo(() => {
    if (agentFilter === "all") return viewEvents;
    return viewEvents.filter((ev) => ev.agentId === agentFilter);
  }, [agentFilter, viewEvents]);

  const groups = useMemo(() => {
    const byTick = new Map<number, typeof filtered>();
    for (const ev of filtered) {
      const list = byTick.get(ev.tick) ?? [];
      list.push(ev);
      byTick.set(ev.tick, list);
    }
    return [...byTick.entries()]
      .sort(([a], [b]) => b - a)
      .map(([tick, events]) => ({
        tick,
        events: [...events].reverse(),
      }));
  }, [filtered]);

  const toggleTick = (tick: number) => {
    setExpandedTicks((prev) => {
      const next = new Set(prev);
      if (next.has(tick)) next.delete(tick);
      else next.add(tick);
      return next;
    });
  };

  const toggleEvent = (eventId: string) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const latestGroupTick = groups[0]?.tick;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">居民筛选</span>
          <select
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
          >
            <option value="all">全部居民</option>
            {TOWN_AGENT_IDS.map((id) => (
              <option key={id} value={id}>
                {TOWN_AGENT_NAMES[id]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {(run?.tick ?? 0) > 0
              ? "当前筛选下暂无事件。"
              : "推进 tick 后，此处按 tick 折叠显示 sim.* 事件。"}
          </p>
        ) : (
          <ul className="space-y-2">
            {groups.map(({ tick, events }) => {
              const expanded =
                expandedTicks.has(tick) ||
                (expandedTicks.size === 0 && tick === latestGroupTick);
              return (
                <li
                  key={tick}
                  className="overflow-hidden rounded-xl border border-border bg-background"
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
                    onClick={() => toggleTick(tick)}
                  >
                    {expanded ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="text-sm font-medium text-foreground">
                      Tick {tick}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {events.length} 条
                    </span>
                  </button>
                  {expanded ? (
                    <ul className="space-y-1 border-t border-border px-3 py-2">
                      {events.map((ev) => {
                        const interaction = ev.interaction;
                        const isInteraction = ev.type === "sim.interaction";
                        const eventExpanded = expandedEvents.has(ev.id);
                        const canExpand = isInteraction && interaction;

                        return (
                          <li
                            key={ev.id}
                            className="rounded-lg border border-border/60 px-2.5 py-2"
                          >
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                              {interaction ? (
                                <InteractionKindIcon kind={interaction.kind} />
                              ) : null}
                              <span className="text-foreground">
                                {isInteraction && interaction
                                  ? interactionKindLabel(interaction.kind)
                                  : (SIM_EVENT_LABELS[ev.type] ?? ev.type)}
                              </span>
                              {ev.agentId ? (
                                <span>{agentLabel(ev.agentId)}</span>
                              ) : null}
                            </div>
                            <p className="mt-1 text-xs text-foreground">
                              {ev.summary}
                            </p>
                            {canExpand ? (
                              <>
                                <button
                                  type="button"
                                  className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                                  onClick={() => toggleEvent(ev.id)}
                                >
                                  {eventExpanded ? (
                                    <ChevronDown className="h-3 w-3" />
                                  ) : (
                                    <ChevronRight className="h-3 w-3" />
                                  )}
                                  {eventExpanded ? "收起详情" : "展开详情"}
                                </button>
                                {eventExpanded ? (
                                  <InteractionEventDetails
                                    interaction={interaction}
                                  />
                                ) : null}
                              </>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
