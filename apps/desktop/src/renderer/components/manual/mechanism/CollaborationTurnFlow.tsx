// 实现入口（喂 AI，不渲染）：步骤 → SSE 事件 → 代码
//  1 用户输入       turn_saved                              GraphView · INPUT_ID
//  2 CEO 判断组团    delegate(tasks, depends_on)             tools/builtin/delegate.py
//  3 run_plan 预声明 run_plan                                runs/builder.py
//  4 逐波调度       run_started · run_progress              runs/wave.py
//  5 worker 执行    run_output_delta→run_completed/failed   runs/executor.py · engine.py
//  6 CEO 收尾       content_delta                           tools/builtin/delegate.py
//  7 答案入气泡     message_end                             GraphView · captainRun
// SSE 事件语义详见 docs/03-AI核心/执行引擎架构设计.md §十二。
const TURN_FLOW: {
  title: string;
  desc: string;
  note?: string;
}[] = [
  {
    title: "用户输入",
    desc: "你的提问落库；图上是「你的任务」端点（无 run 的合成节点）。",
    note: "回传权威 user_message_id，前端把乐观气泡换成真实行。",
  },
  {
    title: "CEO 判断是否组团",
    desc: "chat 档直接流式作答（零编排开销）；只有需要产出 / 变更或团队时才调 delegate。",
    note: "并行/串行由 depends_on 数据声明，不靠模型主动发并行调用。",
  },
  {
    title: "run_plan 预声明",
    desc: "一次性把本批 run 节点点亮为 pending，图在开跑前即成形（带 parent_run_id 成组）。",
  },
  {
    title: "WaveScheduler 逐波调度",
    desc: "无依赖的节点同波并行起跑，有依赖的等上游齐了再解锁；asyncio 协程并发。",
  },
  {
    title: "worker 执行",
    desc: "每个 worker 跑自己的 ReAct 循环（工具调用 + 收敛治理），答案流式推送、入边走粒子流。",
  },
  {
    title: "CEO 收尾汇报",
    desc: "非终态返回 CEO，用自己的声音写一段简短概览；单 worker 且 finalize 时其产出直接作答。",
  },
  {
    title: "答案入气泡",
    desc: "CEO 汇聚点节点 = 这段最终答案，点它跳到气泡；回合收口。",
    note: "含 finish_reason / usage，前端递归收口悬挂节点兜底。",
  },
];

/** ② 协作回合主线：从你的提问到答案落进气泡的完整生命周期。 */
export function CollaborationTurnFlow() {
  return (
    <ol className="space-y-0">
      {TURN_FLOW.map((s, i) => (
        <li key={s.title} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className="z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
              {i + 1}
            </span>
            {i < TURN_FLOW.length - 1 && (
              <span className="my-1 w-px flex-1 bg-border" />
            )}
          </div>
          <div className="min-w-0 flex-1 pb-5">
            <p className="text-sm font-medium text-foreground">{s.title}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {s.desc}
            </p>
            {s.note && (
              <p className="mt-1 text-xs text-muted-foreground/70">{s.note}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
