import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type {
  Execution,
  RevisionChain,
  RevisionVersion,
  RunNode,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { StatusDot } from "./ComparePane";
import { charCount, outputOf, placeholder, preview, versionTag } from "./cells";

/**
 * 版本链形态的纵览层（定向唤回「修订 vN」）——每条被改 worker 一条**版本轨**（全版纵览），下挂一个
 * **聚焦精读**面（默认读最新一版，全宽）。对比模式下，轨上每张版本卡变成可 pick 的 A/B 选取项
 * （可同链跨版本、也可跨链），选中的两版喂给共享的 {@link import("./ComparePane").ComparePane}。
 * 纯投影：读同一份 {@link Execution}（修订由 `run_started` 帧合成进来），live / 回放渲染一致。
 */
export function RevisionOverview({
  chains,
  execution,
  messageId,
  compareMode,
  pair,
  onPick,
}: {
  chains: RevisionChain[];
  execution: Execution;
  messageId: string;
  compareMode: boolean;
  /** 当前 A/B 选中的两个 `run.id`（display order：A 在前）。 */
  pair: [string, string];
  onPick: (runId: string) => void;
}) {
  return (
    <div className="space-y-4">
      {chains.map((chain) => (
        <ChainRow
          key={chain.originalId}
          chain={chain}
          execution={execution}
          messageId={messageId}
          compareMode={compareMode}
          pair={pair}
          onPick={onPick}
        />
      ))}
    </div>
  );
}

/** 一条被改 worker 的版本链：角色标签 + 版本轨（纵览）。聚焦模式下焦点面读一版；对比模式下轨上
 * 版本卡可 pick 进 turn 级 A/B 对（本链把它的版本贡献给任意两版对比）。 */
function ChainRow({
  chain,
  execution,
  messageId,
  compareMode,
  pair,
  onPick,
}: {
  chain: RevisionChain;
  execution: Execution;
  messageId: string;
  compareMode: boolean;
  pair: [string, string];
  onPick: (runId: string) => void;
}) {
  const original = chain.versions[0].run;
  const agent = execution.agents.find((a) => a.id === original.agentId);
  const role = agent?.role ?? original.agentId;
  const versions = chain.versions;
  const latest = versions[versions.length - 1].version;

  const [focus, setFocus] = useState<number>(latest);

  const byVersion = (v: number): RevisionVersion =>
    versions.find((x) => x.version === v) ?? versions[0];

  return (
    <div className="space-y-1.5">
      <span className="inline-block rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
        {role}
      </span>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {versions.map((version) => {
          const badge =
            version.run.id === pair[0]
              ? "A"
              : version.run.id === pair[1]
                ? "B"
                : null;
          return (
            <VersionChip
              key={version.run.id}
              version={version}
              latest={latest}
              execution={execution}
              active={compareMode ? badge != null : version.version === focus}
              badge={compareMode ? badge : null}
              onPick={() =>
                compareMode ? onPick(version.run.id) : setFocus(version.version)
              }
            />
          );
        })}
      </div>

      {!compareMode && (
        <FocusPane
          version={byVersion(focus)}
          latest={latest}
          role={role}
          messageId={messageId}
          output={outputOf(execution, byVersion(focus).run)}
        />
      )}
    </div>
  );
}

/** 版本轨上的一版：状态 + vN + 原始/最新 tag + 字数 + 两行预览。选中（焦点、或对比 A/B 槽）加环；
 * 对比槽带 A/B 徽章。 */
function VersionChip({
  version,
  latest,
  execution,
  active,
  badge,
  onPick,
}: {
  version: RevisionVersion;
  latest: number;
  execution: Execution;
  active: boolean;
  badge: "A" | "B" | null;
  onPick: () => void;
}) {
  const { run } = version;
  const output = outputOf(execution, run);
  const tag = versionTag(version.version, latest);

  return (
    <button
      type="button"
      onClick={onPick}
      className={`flex w-40 shrink-0 flex-col gap-1 rounded-lg border p-2 text-left transition-colors ${
        active
          ? "border-primary bg-primary/5"
          : "border-border bg-muted/30 hover:border-muted-foreground/40"
      }`}
    >
      <span className="flex items-center gap-1.5">
        <StatusDot status={run.status} />
        <span className="text-xs font-medium text-foreground">
          v{version.version}
        </span>
        {tag && <span className="text-xs text-muted-foreground">{tag}</span>}
        <span className="flex-1" />
        {badge && (
          <span className="rounded bg-primary px-1 text-xs font-semibold text-primary-foreground">
            {badge}
          </span>
        )}
      </span>
      <span className="text-xs text-muted-foreground">
        {output ? `${charCount(output)} 字` : placeholder(run)}
      </span>
      {output && (
        <span className="line-clamp-2 text-xs leading-snug text-muted-foreground/80">
          {preview(output)}
        </span>
      )}
    </button>
  );
}

/** 全宽读一版。头部钻完整 run 详情（深度详情的唯一归宿）；产出限高 60vh 让长稿可滚。 */
function FocusPane({
  version,
  latest,
  role,
  messageId,
  output,
}: {
  version: RevisionVersion;
  latest: number;
  role: string;
  messageId: string;
  output: string;
}) {
  const { run } = version;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/20">
      <VersionHeader
        version={version.version}
        latest={latest}
        run={run}
        role={role}
        messageId={messageId}
      />
      <div className="p-3">
        {output ? (
          <div className="max-h-[60vh] overflow-y-auto text-sm">
            <Markdown content={output} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{placeholder(run)}</p>
        )}
      </div>
    </div>
  );
}

/** 焦点面头部：vN + 原始/最新 tag + 钻完整 run 详情。 */
function VersionHeader({
  version,
  latest,
  run,
  role,
  messageId,
}: {
  version: number;
  latest: number;
  run: RunNode;
  role: string;
  messageId: string;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const tag = versionTag(version, latest);
  return (
    <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
      <StatusDot status={run.status} />
      <span className="text-xs font-medium text-foreground">v{version}</span>
      {tag && <span className="text-xs text-muted-foreground">{tag}</span>}
      <span className="flex-1" />
      <SimpleTooltip label="查看完整产出">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => showRunDetail(messageId, run.id, role)}
          className="h-6 gap-1 px-2 text-muted-foreground"
        >
          完整产出
          <ChevronRight size={12} />
        </Button>
      </SimpleTooltip>
    </div>
  );
}
