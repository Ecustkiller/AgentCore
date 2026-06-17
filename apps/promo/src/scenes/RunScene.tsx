import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { AssistantProse, UserBubble } from "../chrome/ChatBits";
import { MAIN_H, MAIN_W } from "../chrome/PromoShell";
import { DEMO_TASK } from "../data/demo";
import { GraphStage } from "../graph/GraphStage";
import { buildGraphState, GRAPH_SCENE_FRAMES } from "../graph/graphState";
import { caretVisible, entranceStyle, typeOut } from "../motion/primitives";

/*
 * 7–24s, the heart of the film (scene-local 0–510 @30fps). One continuous
 * timeline so the graph enters exactly once:
 *   0–390   (7–20s) cascade entrance + 4-wave execution (graphState)
 *   390–510 (20–24s) 汇聚点 lights up, the graph recedes, and the CEO's final
 *           answer streams into the chat bubble.
 */

const ANSWER_AT = GRAPH_SCENE_FRAMES; // 390 — convergence begins
const CAPTAIN_PREVIEW = "汇总团队结论，输出最终方案……";

const ANSWER = `综合团队的并行调研、正反方辩论与策略裁决，结论如下：

以「真正的多 Agent 团队协作」为核心差异点切入——先用一条最小可用的协作主链路验证关键风险，再分阶段放大投入。

首版聚焦 6 个里程碑；技术上以 DAG 调度 + 共享工作区 + MCP/A2A 为骨架，让团队能真正分工、并行、互相校对。`;

export function RunMain() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const inAnswer = frame >= ANSWER_AT;
  const captain = inAnswer
    ? {
        status: frame < ANSWER_AT + 16 ? "running" : "completed",
        preview: typeOut(CAPTAIN_PREVIEW, frame, ANSWER_AT, fps, 30),
        terminalFrame: ANSWER_AT + 14,
      }
    : undefined;

  const { nodes, edges, debate } = buildGraphState(frame, fps, { captain });

  // The graph recedes as the answer takes over (stays faintly visible behind).
  const graphOpacity = interpolate(
    frame,
    [ANSWER_AT + 24, ANSWER_AT + 64],
    [1, 0.12],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const answerOpacity = interpolate(
    frame,
    [ANSWER_AT + 34, ANSWER_AT + 54],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const answerText = typeOut(ANSWER, frame, ANSWER_AT + 44, fps, 50);
  const answerStreaming = answerText.length < ANSWER.length;
  const userBubble = entranceStyle(frame, ANSWER_AT + 34);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", inset: 0, opacity: graphOpacity }}>
        <GraphStage
          nodes={nodes}
          edges={edges}
          debate={debate}
          frame={frame}
          boxWidth={MAIN_W}
          boxHeight={MAIN_H}
        />
      </div>

      {frame >= ANSWER_AT + 30 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: answerOpacity,
            overflow: "hidden",
          }}
        >
          <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center gap-5 px-6">
            <div
              style={{
                opacity: userBubble.opacity,
                transform: userBubble.transform,
              }}
            >
              <UserBubble text={DEMO_TASK} />
            </div>
            <AssistantProse
              text={answerText}
              caret={answerStreaming && caretVisible(frame, fps)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
