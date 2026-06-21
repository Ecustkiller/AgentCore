import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { agentColorVar, agentGlyph } from "@/lib/agentIdentity";
import { formatCompact, formatDuration } from "@/lib/format";
import {
  MODEL_TIER_META,
  type ModelTier,
  type ReasoningEffort,
  type RunCheckpoint,
  type RunStatus,
  STANCE_META,
  type Stance,
  toolLabel,
} from "@/stores/execution";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import {
  ArrowUp,
  Check,
  Clock,
  CornerDownRight,
  FileText,
  History,
  Loader2,
  Pause,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useTerminalFlash } from "./useTerminalFlash";

interface AgentNodeData {
  agentId: string;
  role: string;
  modelPreference?: ModelTier;
  reasoningEffort?: ReasoningEffort;
  runId: string;
  status: RunStatus;
  isAnimating: boolean;
  /** This worker's assigned task (run.task). The node's stable "在干什么" line —
   * shown whenever it is not actively streaming its own output. */
  task: string;
  outputPreview: string;
  /** Tail of the worker's streamed reasoning (run_reasoning_delta). Shown as the
   * live "思考中" preview while the run is thinking — DeepSeek streams the whole
   * reasoning before any content, so without this fallback a running node sits
   * blank (no output yet) for the entire, often long, thinking phase. */
  reasoningPreview?: string;
  /** The tool call this worker is currently composing (run_tool_progress): name +
   * chars of arguments streamed so far. Non-null only during active assembly. It
   * ranks ABOVE the output preview while running, because a file-writing worker's
   * deliverable streams as tool ARGUMENTS (not content) — without this the node is
   * frozen for the whole, often minute-long, write. */
  toolProgress?: { toolName: string; chars: number } | null;
  tokenCount: number;
  toolCount: number;
  /** 1C 产物落点: distinct files this worker committed via file_write/str_replace,
   * in first-write order. Drives the artifact chips on the face + peek so「谁产出了
   * 哪个文件」reads off the graph. Empty for workers that wrote nothing. */
  artifacts?: string[];
  focused: boolean;
  /** Billed model id (run_completed); null until the run finishes. */
  model?: string | null;
  /** Wall-clock run duration in ms; null until the run finishes. */
  durationMs?: number | null;
  /** Real billed tokens (input+output) once metered; 0 while streaming. */
  realTokens?: number;
  /** Pre-formatted ¥ run cost (e.g.「¥0.05」); undefined until priced or when
   * zero. Computed in GraphView (it owns the single FX rate). No longer drawn on
   * the card face (¥ lives in the run-detail 资源消耗 panel, §7.3B); kept only to
   * feed the screen-reader aria-label. */
  costText?: string;
  /** Edge anchor orientation, driven by the active graph layout. */
  handleDirection?: "vertical" | "horizontal";
  /** 阶段2: this run is a nested sub-worker (delegated by another worker), so the
   * card carries a 子任务 badge to set it apart from a top-level teammate. */
  isSubtask?: boolean;
  /** 乙 热修 P4: this node is a 定向唤回 续写 of an original run; `revision` is its
   * version number (≥2), shown as a「修订 vN」badge so a re-do reads as a version
   * of the same worker rather than a new teammate. */
  isRevision?: boolean;
  revision?: number;
  /** 辩论/审查 side (前端UX设计.md §四): badges the node 正方/反方; null/undefined on
   * an ordinary teammate. */
  stance?: Stance | null;
  /** 结构化挂起 2a (7.2A): a `checkpoint_after` pause that fired after this run, or
   * null. Drives the node's「待放行 / 已放行 / 已停止」pause badge. */
  checkpoint?: RunCheckpoint | null;
  /** 阻塞式求决策 §4.5B: how many of this worker's escalations are PENDING (blocking,
   * awaiting the user) — drives the amber「待你拍板」badge (actionable). Drops to 0 once
   * answered / timed out, so the badge clears on resolution. */
  escalationPending?: number;
  /** 升级实时可见: how many NON-blocking escalations this worker raised (`run_escalation`)
   * — drives the muted「上报」badge (informational; the CEO resolves these at synthesis).
   * Shown only when there is no pending one (待你拍板 takes priority). */
  escalationRaised?: number;
  /** Position in the plan, used to stagger the entrance animation. */
  enterIndex?: number;
  /** Keyboard activation (Enter/Space) — mirrors a plain node click. */
  onActivate?: () => void;
  [key: string]: unknown;
}

const TIER_BADGE_STYLES: Record<ModelTier, string> = {
  strong: "bg-primary/10 text-primary",
  fast: "bg-muted text-muted-foreground",
};

// 1C 产物 chip caps: the compact face shows a couple, the roomier hover peek more.
const FACE_ARTIFACT_CAP = 2;
const PEEK_ARTIFACT_CAP = 6;

// The card ring + surface per status (identity now owns the avatar, so the disc no
// longer carries the status icon — see PRESENCE_STYLES for the small status dot).
const STATUS_STYLES: Record<string, { ring: string; bg: string }> = {
  pending: { ring: "ring-muted-foreground/30", bg: "bg-card" },
  ready: { ring: "ring-muted-foreground/30", bg: "bg-card" },
  running: { ring: "ring-primary", bg: "bg-card" },
  completed: { ring: "ring-success", bg: "bg-card" },
  failed: { ring: "ring-destructive", bg: "bg-card" },
  cancelled: { ring: "ring-muted-foreground/30", bg: "bg-muted" },
};

// The status "presence dot" overlaid on the identity avatar (like a chat avatar's
// online dot): keeps run status legible at a glance now that the disc shows WHO the
// agent is, not its status. Color follows color-tokens.mdc; running/done/failed add a
// tiny glyph so status survives without color (the non-color cue the old icon gave).
const PRESENCE_STYLES: Record<
  string,
  { cls: string; icon: React.ReactNode | null }
> = {
  pending: { cls: "bg-muted-foreground/50", icon: null },
  ready: { cls: "bg-muted-foreground/50", icon: null },
  running: {
    cls: "bg-primary",
    icon: <Loader2 size={9} className="animate-spin text-primary-foreground" />,
  },
  completed: {
    cls: "bg-success",
    icon: (
      <Check size={9} strokeWidth={3} className="text-success-foreground" />
    ),
  },
  failed: {
    cls: "bg-destructive",
    icon: (
      <X size={9} strokeWidth={3} className="text-destructive-foreground" />
    ),
  },
  cancelled: { cls: "bg-muted-foreground/50", icon: null },
};

export function AgentNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  const style = STATUS_STYLES[d.status] ?? STATUS_STYLES.pending;
  const presence = PRESENCE_STYLES[d.status] ?? PRESENCE_STYLES.pending;
  // Identity (角色身份): a stable color + monogram derived from the role string, so
  // each teammate reads as a distinct "person" instead of an identical Bot icon.
  const identityColor = agentColorVar(d.role);
  const identityGlyph = agentGlyph(d.role);
  // 1C 产物落点: this worker's committed files. The face shows the first FACE_ARTIFACT_CAP
  // as chips with a「+N」overflow; the peek lists more. Kept compact so the face stays
  // 「角色 → 在干什么 → 产物 → 用时/工具」.
  const artifacts = d.artifacts ?? [];
  const isRunning = d.status === "running";
  // 运行中中行优先级（修「看不到 worker 流式输出」的主因）：
  //  ① 正在生成的工具调用 —— 其参数（如 file_write 的文件正文）既不是 content 也不是
  //     reasoning，且 tool_use_start 要等参数拼完才触发，否则整段写入期（常达分钟级）
  //     节点完全空白；故运行中只要在拼工具调用就优先显示它。
  //  ② 自己的流式输出（带光标）。
  //  ③ 输出未到时回退思考末尾预览（斜体，读作「内心独白」），思考期不空白。
  //  ④ 都没到则落回任务一句话。
  const liveTool = isRunning ? (d.toolProgress ?? null) : null;
  const livePreview = isRunning && !liveTool ? d.outputPreview : "";
  const liveThinking =
    isRunning && !liveTool && !livePreview ? (d.reasoningPreview ?? "") : "";
  const horizontal = d.handleDirection === "horizontal";
  // Single highlight source: the side panel's active run tab for this turn
  // (projected into `d.focused`). React Flow's built-in selection is off
  // (GraphView elementsSelectable={false}), so there is no competing `selected`.
  const highlighted = d.focused;
  const flashing = useTerminalFlash(d.status);
  const flashColor =
    d.status === "failed" ? "var(--destructive)" : "var(--success)";
  // Cascade entrance by plan order, capped so big teams still finish promptly.
  const enterDelay = Math.min((d.enterIndex ?? 0) * 35, 280);

  // Shared facts for the card chip and the a11y label: prefer the real metered
  // numbers once the run finishes, fall back to the streaming estimate / tier
  // label while it is still running.
  const modelText =
    d.model ??
    (d.modelPreference ? MODEL_TIER_META[d.modelPreference].label : "—");
  const tokenText =
    d.realTokens && d.realTokens > 0
      ? formatCompact(d.realTokens)
      : d.tokenCount > 0
        ? `≈${formatCompact(d.tokenCount)}`
        : "—";
  const durationText = d.durationMs ? formatDuration(d.durationMs) : null;
  // 节点 face 保持简洁「角色 → 在干什么 → 用时/工具」，数字类（model / token / ¥）
  // 不上卡片、全部归右侧 run 详情面板的「资源消耗」区段；这里仍算出来只为喂下方
  // 屏幕阅读器 aria-label（无障碍仍播报完整事实）。用时则真正画在脚注。
  const ariaLabel = `${d.role}，${statusLabel(d.status)}，模型 ${modelText}，Token ${tokenText}${
    d.costText ? `，成本 ${d.costText}` : ""
  }${durationText ? `，用时 ${durationText}` : ""}${
    d.toolCount > 0 ? `，工具 ${d.toolCount} 次` : ""
  }${artifacts.length > 0 ? `，产物 ${artifacts.length} 个` : ""}${
    d.checkpoint ? `，检查点${checkpointBadge(d.checkpoint).label}` : ""
  }${
    (d.escalationPending ?? 0) > 0
      ? `，${d.escalationPending} 项待你拍板`
      : (d.escalationRaised ?? 0) > 0
        ? `，上报 ${d.escalationRaised} 条`
        : ""
  }`;

  // 2B hover 速览: the layer between the compact face and the full right-side panel —
  // hovering a node surfaces a richer peek (task + a longer activity/output preview +
  // a stats line) without committing to opening the detail panel. Reuses the same
  // live/output signals the face shows, just with room to breathe.
  const peekActivity: {
    heading: string;
    text: string;
    italic?: boolean;
  } | null = liveTool
    ? {
        heading: "正在生成",
        text: `${toolLabel(liveTool.toolName)}${
          liveTool.chars > 0 ? ` · ${formatCompact(liveTool.chars)} 字` : ""
        }`,
      }
    : livePreview
      ? { heading: "输出中", text: livePreview }
      : liveThinking
        ? { heading: "思考中", text: liveThinking, italic: true }
        : d.outputPreview
          ? { heading: "产出预览", text: d.outputPreview }
          : null;
  // Classification tags for the peek header (mirrors the face's badge row as plain text
  // so the peek is self-contained).
  const peekTags: string[] = [];
  if (d.stance) peekTags.push(STANCE_META[d.stance].label);
  if (d.isSubtask) peekTags.push("子任务");
  if (d.isRevision) peekTags.push(`修订 v${d.revision ?? 2}`);
  if (d.checkpoint) peekTags.push(checkpointBadge(d.checkpoint).label);
  if ((d.escalationPending ?? 0) > 0) {
    peekTags.push(
      `待你拍板${(d.escalationPending ?? 0) > 1 ? ` ${d.escalationPending}` : ""}`,
    );
  } else if ((d.escalationRaised ?? 0) > 0) {
    peekTags.push(
      `上报${(d.escalationRaised ?? 0) > 1 ? ` ${d.escalationRaised}` : ""}`,
    );
  }

  return (
    <>
      <Handle
        type="target"
        position={horizontal ? Position.Left : Position.Top}
        className="!bg-border"
      />
      {/* Entrance wrapper: keeps the once-on-mount scale/fade off the card so it
          never collides with the card's running `animate-pulse` (both set the CSS
          `animation` property). */}
      <div
        className="animate-graph-node-enter"
        style={{ animationDelay: `${enterDelay}ms` }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            {/* biome-ignore lint/a11y/useSemanticElements: a graph node is a composite (icon + multi-line text + badges) that a native <button> may not contain; it is keyboard-activable via role + onKeyDown. */}
            <div
              role="button"
              tabIndex={0}
              aria-label={ariaLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  d.onActivate?.();
                }
              }}
              style={
                { "--graph-flash-color": flashColor } as React.CSSProperties
              }
              className={`relative w-[210px] cursor-pointer rounded-xl border px-3 py-2.5 text-left shadow-sm outline-none ring-2 ${style.bg} ${style.ring} ${isRunning ? "animate-pulse" : ""} ${flashing ? "animate-graph-node-flash" : ""} ${
                highlighted
                  ? "outline outline-2 outline-offset-2 outline-primary"
                  : "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <div className="relative shrink-0">
                  <div
                    className="flex size-7 items-center justify-center rounded-full text-sm font-semibold"
                    style={{
                      backgroundColor: `color-mix(in oklab, ${identityColor} 18%, transparent)`,
                      color: identityColor,
                    }}
                  >
                    {identityGlyph}
                  </div>
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full ring-2 ring-card ${presence.cls}`}
                  >
                    {presence.icon}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {d.role}
                  </p>
                  {/* 第二行仅在有「立场 / 子任务 / 修订」分类标记时出现；状态不再用文字
                  重复（图标 + 色环 + 运行脉冲已表达），普通队员只剩单行角色名，不再被
                  徽章挤到截断。 */}
                  {(d.stance ||
                    d.isSubtask ||
                    d.isRevision ||
                    d.checkpoint ||
                    (d.escalationPending ?? 0) > 0 ||
                    (d.escalationRaised ?? 0) > 0) && (
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      {d.stance && (
                        <span className="shrink-0 rounded-full bg-info/10 px-1.5 py-0.5 font-medium text-info">
                          {STANCE_META[d.stance].label}
                        </span>
                      )}
                      {d.isSubtask && (
                        <span className="flex shrink-0 items-center gap-1">
                          <CornerDownRight
                            size={10}
                            className="text-primary/70"
                          />
                          子任务
                        </span>
                      )}
                      {d.isRevision && (
                        <span className="flex shrink-0 items-center gap-1 rounded-full bg-info/10 px-1.5 py-0.5 font-medium text-info">
                          <History size={10} />
                          修订 v{d.revision ?? 2}
                        </span>
                      )}
                      {d.checkpoint &&
                        (() => {
                          const badge = checkpointBadge(d.checkpoint);
                          return (
                            <span
                              className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${badge.cls}`}
                            >
                              <Pause size={10} />
                              {badge.label}
                            </span>
                          );
                        })()}
                      {(d.escalationPending ?? 0) > 0 ? (
                        <span className="flex shrink-0 items-center gap-1 rounded-full bg-warning/10 px-1.5 py-0.5 font-medium text-warning">
                          <ArrowUp size={10} />
                          待你拍板
                          {(d.escalationPending ?? 0) > 1
                            ? ` ${d.escalationPending}`
                            : ""}
                        </span>
                      ) : (
                        (d.escalationRaised ?? 0) > 0 && (
                          <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
                            <ArrowUp size={10} />
                            上报
                            {(d.escalationRaised ?? 0) > 1
                              ? ` ${d.escalationRaised}`
                              : ""}
                          </span>
                        )
                      )}
                    </p>
                  )}
                </div>
                {d.modelPreference && (
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium ${TIER_BADGE_STYLES[d.modelPreference]}`}
                  >
                    {MODEL_TIER_META[d.modelPreference].short}
                  </span>
                )}
                {d.reasoningEffort === "max" && (
                  <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                    <Sparkles size={10} />
                    深度
                  </span>
                )}
              </div>

              {/* 中行 = 这个节点「在干什么」：运行中优先显「正在生成工具调用」（写文件等，
              否则整段写入期空白），再到流式输出（带光标），输出未到回退思考末尾（斜体 +
              「思考中」光标），都没到落回任务一句话；非运行态显被分配的任务（run.task）。 */}
              {liveTool ? (
                <p className="mt-2 line-clamp-2 text-xs leading-snug text-primary/90">
                  正在生成 {toolLabel(liveTool.toolName)}
                  {liveTool.chars > 0 && (
                    <span className="text-muted-foreground/70">
                      {" · "}
                      {formatCompact(liveTool.chars)} 字
                    </span>
                  )}
                  <span className="ml-0.5 inline-block animate-pulse text-primary">
                    ▋
                  </span>
                </p>
              ) : livePreview ? (
                <p className="mt-2 line-clamp-2 text-xs leading-snug text-muted-foreground/80">
                  {livePreview}
                  <span className="ml-0.5 inline-block animate-pulse text-primary">
                    ▋
                  </span>
                </p>
              ) : liveThinking ? (
                <p className="mt-2 line-clamp-2 text-xs italic leading-snug text-muted-foreground/60">
                  {liveThinking}
                  <span className="ml-0.5 inline-block animate-pulse text-primary">
                    ▋
                  </span>
                </p>
              ) : (
                d.task && (
                  <p className="mt-2 line-clamp-2 text-xs leading-snug text-muted-foreground/70">
                    {d.task}
                  </p>
                )
              )}

              {/* 产物落点 chip 行（1C）：本节点已落盘的文件（file_write/str_replace），最多
              FACE_ARTIFACT_CAP 个 + 「+N」溢出。与中行的「正在生成」分离——chip 是已提交
              成果，中行是进行中的写入。 */}
              {artifacts.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {artifacts.slice(0, FACE_ARTIFACT_CAP).map((p) => (
                    <span
                      key={p}
                      title={p}
                      className="flex max-w-[120px] items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    >
                      <FileText size={11} className="shrink-0" />
                      <span className="truncate">{basename(p)}</span>
                    </span>
                  ))}
                  {artifacts.length > FACE_ARTIFACT_CAP && (
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      +{artifacts.length - FACE_ARTIFACT_CAP}
                    </span>
                  )}
                </div>
              )}

              {/* 脚注只留「用时 · 工具数」两个轻信号；¥ / token 已移交 run 详情面板。 */}
              {(durationText || d.toolCount > 0) && (
                <div className="mt-1.5 flex items-center gap-2.5 text-xs text-muted-foreground">
                  {durationText && (
                    <span className="flex items-center gap-1">
                      <Clock size={11} />
                      <span className="tabular-nums">{durationText}</span>
                    </span>
                  )}
                  {d.toolCount > 0 && (
                    <span className="flex items-center gap-1">
                      <Wrench size={11} />
                      <span className="tabular-nums">{d.toolCount}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" align="start" className="w-72">
            <div className="space-y-2 py-1">
              <div className="flex items-center gap-2">
                <span
                  className="flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                  style={{
                    backgroundColor: `color-mix(in oklab, ${identityColor} 18%, transparent)`,
                    color: identityColor,
                  }}
                >
                  {identityGlyph}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {d.role}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {statusLabel(d.status)}
                </span>
              </div>
              {peekTags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {peekTags.map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {d.task && (
                <div className="space-y-0.5">
                  <p className="text-muted-foreground">任务</p>
                  <p className="line-clamp-4 text-foreground">{d.task}</p>
                </div>
              )}
              {peekActivity && (
                <div className="space-y-0.5">
                  <p className="text-muted-foreground">
                    {peekActivity.heading}
                  </p>
                  <p
                    className={`line-clamp-5 whitespace-pre-wrap break-words text-foreground ${
                      peekActivity.italic ? "italic" : ""
                    }`}
                  >
                    {peekActivity.text}
                  </p>
                </div>
              )}
              {artifacts.length > 0 && (
                <div className="space-y-1">
                  <p className="text-muted-foreground">
                    产物{artifacts.length > 1 ? ` · ${artifacts.length}` : ""}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {artifacts.slice(0, PEEK_ARTIFACT_CAP).map((p) => (
                      <span
                        key={p}
                        title={p}
                        className="flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-foreground"
                      >
                        <FileText size={11} className="shrink-0" />
                        <span className="truncate">{basename(p)}</span>
                      </span>
                    ))}
                    {artifacts.length > PEEK_ARTIFACT_CAP && (
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
                        +{artifacts.length - PEEK_ARTIFACT_CAP}
                      </span>
                    )}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border pt-1.5 text-muted-foreground">
                <span>模型 {modelText}</span>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{tokenText} tokens</span>
                {durationText && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums">{durationText}</span>
                  </>
                )}
                {d.toolCount > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums">工具 {d.toolCount}</span>
                  </>
                )}
                {d.costText && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{d.costText}</span>
                  </>
                )}
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
      <Handle
        type="source"
        position={horizontal ? Position.Right : Position.Bottom}
        className="!bg-border"
      />
    </>
  );
}

/** Last path segment of an artifact path. Workers emit POSIX-style relative paths, but
 * a stray backslash separator is handled too so a Windows-style path still chips down to
 * its filename. A trailing slash (unlikely for a written file) is trimmed first. */
function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

function statusLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    pending: "等待中",
    ready: "就绪",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已停止",
  };
  return labels[status] ?? status;
}

/** The pause-badge label + palette for a node's structured checkpoint (plan_review,
 * 结构化挂起): 待放行 while the user has not answered, then 已放行 (continued) / 已调整
 * (continued with a steer injected downstream) / 已停止 (the run ended here). A
 * timeout folds in as 已放行 (the engine continued). */
function checkpointBadge(c: RunCheckpoint): { label: string; cls: string } {
  if (c.status === "pending") {
    return { label: "待放行", cls: "bg-warning/10 text-warning" };
  }
  if (c.decision === "stop") {
    return { label: "已停止", cls: "bg-destructive/10 text-destructive" };
  }
  if (c.decision === "adjust") {
    return { label: "已调整", cls: "bg-muted text-muted-foreground" };
  }
  return { label: "已放行", cls: "bg-muted text-muted-foreground" };
}
