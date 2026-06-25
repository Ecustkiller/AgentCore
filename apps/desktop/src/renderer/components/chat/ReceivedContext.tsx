import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCompact } from "@/lib/format";
import type { ContextBlockWire } from "@/types/events";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
} from "lucide-react";
import { useState } from "react";

/** Context channel → 中文 label + one-line hint (上下文传递可视化). The single source both
 * the run detail (worker 侧) and the CEO bubble (captain 侧) use to title each「收到的上下文」
 * block by its origin, so the user reads WHERE each piece came from, not just its raw
 * heading. `system`/`history` are the CEO-side opening channels (方案3 通道①). */
const CONTEXT_CHANNEL_META: Record<string, { label: string; hint: string }> = {
  system: { label: "系统提示", hint: "本回合 CEO 实际遵循的系统指令" },
  history: { label: "对话历史", hint: "本回合之前的往来" },
  request: { label: "原始请求", hint: "老板交给整个团队的目标" },
  team_position: { label: "团队位置", hint: "队友与产出去向" },
  dependency: { label: "前置结果", hint: "上游队友交付的产物" },
  workspace: { label: "工作区", hint: "共享工作区可读文件" },
  task: { label: "你的任务", hint: "分派给本 Agent 的具体活" },
  expected_output: { label: "预期产出", hint: "期望交付的形态" },
  requirements: { label: "产出要求", hint: "必须满足的硬约束" },
  steer: { label: "中途指示", hint: "执行中追加的操舵" },
  team_result: { label: "队员回传", hint: "委派的队员交回 CEO 的产物" },
};

/** Dependency fidelity → 中文 label (递指针/摘要/全文): HOW an upstream teammate's product
 * was handed to this run. */
const FIDELITY_META: Record<string, string> = {
  pointer: "递指针",
  summarize: "摘要",
  pass_through: "全文",
};

/**
 * 收到的上下文 (上下文传递可视化) — the structured context a run was actually fed at
 * assembly time (its `run_context` blocks), so the user sees exactly what the LLM read.
 * Worker 侧 (run detail): 原始请求 / 团队位置 / 上游产物 / 工作区 / 任务…; CEO 侧 (chat bubble):
 * 系统提示 / 对话历史 / 原始请求. Collapsible like the resource ledger; opens by default in
 * power mode (用量明细 on). Each block shows its channel origin; a dependency block also
 * surfaces its provenance (来源 / 保真度 / 是否截断).
 *
 * 决策②: the `system` block (the verbatim CEO system prompt) is HIDDEN unless power mode —
 * it's long boilerplate the casual reader doesn't want, but the 用量明细 user can reveal.
 */
export function ReceivedContextSection({
  blocks,
  defaultExpanded,
  powerMode,
}: {
  blocks: ContextBlockWire[];
  defaultExpanded: boolean;
  powerMode: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // 决策②: gate the system-prompt block behind power mode (it's verbatim boilerplate).
  const visible = powerMode
    ? blocks
    : blocks.filter((b) => b.channel !== "system");
  if (visible.length === 0) return null;
  return (
    <section className="mb-4 last:mb-0">
      <Button
        variant="ghost"
        onClick={() => setExpanded((v) => !v)}
        className="h-auto w-full justify-start gap-1.5 px-0 py-0 hover:bg-transparent"
      >
        <span className="flex w-full items-center gap-1.5">
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="flex-1 text-left text-xs font-medium text-muted-foreground">
            收到的上下文
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {visible.length} 段
          </span>
        </span>
      </Button>

      {expanded && (
        <div className="mt-2 space-y-1.5">
          {visible.map((b, i) => (
            <ContextBlockCard
              key={`${b.channel}-${i}`}
              block={b}
              defaultOpen={powerMode}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * 收到的上下文 · CEO 气泡入口 (上下文传递可视化) — the on-demand dialog the chat bubble's
 * hover action row opens to reveal the structured context the turn was actually fed. Unlike
 * the worker-side {@link ReceivedContextSection} (inline in the run detail panel), the CEO
 * bubble keeps this OFF the conversation flow: a turn no longer auto-expands a context block
 * on send; the user clicks「收到的上下文」to inspect it on demand.
 *
 * 决策② retired here: the verbatim 系统提示 (channel `system`) block is shown to EVERYONE in
 * this dialog (no 用量明细 gating). Being on-demand removes the「信息过载」concern, and the
 * prompt was already user-openable — so this also folds the old standalone「提示词」button in
 * (its content == the `system` block). Renders nothing when the turn carried no context
 * (legacy turns with empty `captainContext`).
 */
/** Controlled dialog — trigger lives in {@link AssistantMessageFooter}「更多」菜单。 */
export function ReceivedContextDialog({
  blocks,
  open,
  onOpenChange,
}: {
  blocks: ContextBlockWire[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (blocks.length === 0) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>收到的上下文</DialogTitle>
            <DialogDescription>
              本回合 AI 实际读到的上下文，与喂给模型的逐字一致（系统提示 /
              对话历史 / 原始请求 …）。
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-5 pb-5">
            {blocks.map((b, i) => (
              <ContextBlockCard
                key={`${b.channel}-${i}`}
                block={b}
                defaultOpen={false}
              />
            ))}
          </div>
        </DialogContent>
    </Dialog>
  );
}

/** One「收到的上下文」block: a click-to-expand card. Collapsed shows the channel origin +
 * a peek; expanded reveals the full body the LLM read (head+tail capped on the wire, flagged
 * when 截断). A dependency block adds a provenance line (来自 {role} · 保真度 · 截断) and the
 * artifact files it pointed at. Defaults open in power mode. */
function ContextBlockCard({
  block,
  defaultOpen,
}: {
  block: ContextBlockWire;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = CONTEXT_CHANNEL_META[block.channel] ?? {
    label: block.channel,
    hint: "",
  };
  // Provenance line (来自 {role} · 保真度 · 截断) for blocks that carry an origin: a worker's
  // upstream dependency (通道②) and the CEO's team readback (通道⑤ team_result).
  const hasProvenance =
    block.channel === "dependency" || block.channel === "team_result";
  const peek = block.body.slice(0, 140);
  return (
    <div className="rounded-lg bg-muted px-2.5 py-1.5 text-xs">
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        className="h-auto w-full justify-start gap-2 px-0 py-0 hover:bg-transparent"
      >
        <span className="flex w-full items-center gap-2 text-left">
          {open ? (
            <ChevronDown
              size={12}
              className="mt-0.5 shrink-0 self-start text-muted-foreground"
            />
          ) : (
            <ChevronRight
              size={12}
              className="mt-0.5 shrink-0 self-start text-muted-foreground"
            />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                {meta.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {block.heading}
              </span>
            </span>
            {!open && (
              <span className="mt-0.5 block truncate text-muted-foreground/70">
                {peek || meta.hint}
              </span>
            )}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground/60">
            {formatCompact(block.chars)} 字
          </span>
        </span>
      </Button>

      {open && (
        <div className="mt-1.5 space-y-1.5 pl-[18px]">
          {hasProvenance &&
            (block.source_role || block.fidelity || block.truncated) && (
              <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground/80">
                {block.source_role && (
                  <span className="rounded bg-background px-1.5 py-0.5">
                    来自 {block.source_role}
                  </span>
                )}
                {block.fidelity && (
                  <span className="rounded bg-background px-1.5 py-0.5">
                    {FIDELITY_META[block.fidelity] ?? block.fidelity}
                  </span>
                )}
                {block.truncated && (
                  <span className="rounded-lg bg-background px-1.5 py-0.5 text-warning">
                    已截断
                  </span>
                )}
              </div>
            )}
          <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background p-2 leading-relaxed text-foreground">
            {block.body}
          </div>
          {block.files.length > 0 && (
            <div className="space-y-0.5">
              {block.files.map((f) => (
                <div
                  key={f}
                  className="flex items-center gap-1.5 text-muted-foreground"
                >
                  <CornerDownRight size={11} className="shrink-0" />
                  <span className="truncate font-mono">{f}</span>
                </div>
              ))}
            </div>
          )}
          {block.truncated && !hasProvenance && (
            <p className="text-muted-foreground/60">
              （仅展示节选，完整 {formatCompact(block.chars)} 字已传给 AI）
            </p>
          )}
        </div>
      )}
    </div>
  );
}
