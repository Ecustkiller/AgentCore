import type { SSEEvent } from "@agentcore/contract-types";

/** Mid-flight fan-out snapshot for 宣传图 #8 — customer Demo pack (摘要 / 竞品表 / 讲稿大纲),
 *  truncated before message_end (1/3 workers done, 2 still running with tool progress). */
const TS = (i: number) =>
  `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`;

const USAGE = {
  input: 1200,
  output: 300,
  reasoning: 120,
  cache_hit: 800,
  cache_miss: 400,
};

const COST = {
  input: 240_000,
  cached: 64_000,
  output: 120_000,
  total: 360_000,
  currency: "USD",
};

export const MOBILE_FANOUT_USER_TEXT =
  "帮我把客户 Demo 包准备好：一页方案摘要、竞品对比表、汇报讲稿大纲。";

export const MOBILE_FANOUT_EVENTS: SSEEvent[] = [
  {
    type: "message_start",
    timestamp: TS(0),
    payload: { message_id: "m_fanout", conversation_id: "conv_promo" },
  },
  {
    type: "content_delta",
    timestamp: TS(1),
    payload: { delta: "好，这三块互不依赖，我安排团队并行开工。" },
  },
  {
    type: "tool_use_start",
    timestamp: TS(2),
    payload: {
      tool_call_id: "dc_fanout",
      tool_name: "delegate",
      arguments: {
        tasks: [
          { role: "文案" },
          { role: "调研员" },
          { role: "撰写员" },
        ],
      },
    },
  },
  {
    type: "run_plan",
    timestamp: TS(3),
    payload: {
      execution_id: "exec_fanout",
      plan_type: "multi_agent",
      task_summary: "客户 Demo 包：摘要 + 竞品表 + 讲稿大纲",
      agents: [
        {
          id: "w1",
          role: "文案",
          model_preference: "fast",
          thinking: true,
          reasoning_effort: "high",
        },
        {
          id: "w2",
          role: "调研员",
          model_preference: "fast",
          thinking: true,
          reasoning_effort: "high",
        },
        {
          id: "w3",
          role: "撰写员",
          model_preference: "strong",
          thinking: true,
          reasoning_effort: "high",
        },
      ],
      runs: [
        {
          id: "r1",
          agent_id: "w1",
          task: "撰写一页方案摘要并保存为 proposal.md",
          depends_on: [],
        },
        {
          id: "r2",
          agent_id: "w2",
          task: "整理竞品对比表（功能 / 定价 / 协作）",
          depends_on: [],
        },
        {
          id: "r3",
          agent_id: "w3",
          task: "起草汇报讲稿大纲",
          depends_on: [],
        },
      ],
    },
  },
  {
    type: "run_started",
    timestamp: TS(4),
    payload: {
      run_id: "r1",
      agent_id: "w1",
      parent_run_id: null,
      kind: "agent",
      revision: 0,
    },
  },
  {
    type: "run_started",
    timestamp: TS(5),
    payload: {
      run_id: "r2",
      agent_id: "w2",
      parent_run_id: null,
      kind: "agent",
      revision: 0,
    },
  },
  {
    type: "run_started",
    timestamp: TS(6),
    payload: {
      run_id: "r3",
      agent_id: "w3",
      parent_run_id: null,
      kind: "agent",
      revision: 0,
    },
  },
  {
    type: "run_completed",
    timestamp: TS(7),
    payload: {
      run_id: "r1",
      agent_id: "w1",
      output_summary: "proposal.md 已写入工作区",
      duration_ms: 4200,
      model: "deepseek-v4-flash",
      usage: USAGE,
      cost: COST,
    },
  },
  {
    type: "run_tool_progress",
    timestamp: TS(8),
    payload: {
      run_id: "r2",
      agent_id: "w2",
      tool_name: "file_write",
      chars: 840,
    },
  },
  {
    type: "run_tool_progress",
    timestamp: TS(9),
    payload: {
      run_id: "r3",
      agent_id: "w3",
      tool_name: "file_write",
      chars: 520,
    },
  },
];
