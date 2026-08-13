/**
 * 槽位（换个主题再跑一次）的解析保真与占位符工具。
 *
 * 画布保存 = 把解析出来的 definition 原样 PATCH 回去，所以解析阶段丢掉的顶层字段
 * 会在用户点一次保存后从后端记录里消失——`deliverable` 已经这样被抹过一次。
 * 这里钉死：后端写什么，前端解析后就还是什么。
 */
import { describe, expect, it } from "vitest";
import {
  parseWorkflowDefinition,
  renderSlotText,
  slotKeysInText,
  splitSlotPlaceholders,
  workflowSlotDefaults,
  workflowSlots,
} from "../workflowDefinition";
import { toUserWorkflow } from "../workflows";

const WIRE_DEFINITION = {
  nodes: [
    {
      id: "step1",
      kind: "agent_step",
      role: "调研员",
      task: "调研 {{topic}} 的定价，产出对比表",
    },
  ],
  edges: [],
  slots: [{ key: "topic", label: "主题", default: "Notion 的协作功能" }],
};

describe("parseWorkflowDefinition · 槽位", () => {
  it("解析顶层 slots（key / 名称 / 默认值）", () => {
    expect(workflowSlots(parseWorkflowDefinition(WIRE_DEFINITION))).toEqual([
      { key: "topic", label: "主题", default: "Notion 的协作功能" },
    ]);
  });

  it("解析 → 序列化 → 再解析仍逐字相同（画布保存往返）", () => {
    const once = parseWorkflowDefinition(WIRE_DEFINITION);
    const patched = JSON.parse(JSON.stringify(once)) as unknown;
    expect(parseWorkflowDefinition(patched)).toEqual(once);
  });

  it("槽位上后端新增的未知字段照样透传", () => {
    const def = parseWorkflowDefinition({
      nodes: [],
      edges: [],
      slots: [
        {
          key: "topic",
          label: "主题",
          default: "定价",
          hint: "一句话",
          ord: 2,
        },
      ],
    });
    expect(def.slots?.[0]).toEqual({
      key: "topic",
      label: "主题",
      default: "定价",
      hint: "一句话",
      ord: 2,
    });
  });

  it("definition 顶层的未知字段不被白名单吃掉", () => {
    const def = parseWorkflowDefinition({
      nodes: [],
      edges: [],
      future_policy: { level: 2 },
    });
    expect(def.future_policy).toEqual({ level: 2 });
  });

  it("名称缺省回落到 key；没有 key 的槽位丢弃", () => {
    const def = parseWorkflowDefinition({
      nodes: [],
      edges: [],
      slots: [
        { key: "topic", default: "定价" },
        { label: "无主槽", default: "x" },
        "topic",
      ],
    });
    expect(def.slots).toEqual([
      { key: "topic", label: "topic", default: "定价" },
    ]);
  });

  it("默认值不是字符串时只丢默认值，槽位本身仍在", () => {
    const def = parseWorkflowDefinition({
      nodes: [],
      edges: [],
      slots: [{ key: "topic", label: "主题", default: null, hint: "留着" }],
    });
    expect(def.slots).toEqual([
      { key: "topic", label: "主题", default: "", hint: "留着" },
    ]);
  });

  it("没有 slots 的工作流解析后不凭空长出这个键（旧数据逐字不变）", () => {
    const def = parseWorkflowDefinition({ nodes: [], edges: [] });
    expect("slots" in def).toBe(false);
    expect(workflowSlots(def)).toEqual([]);
  });

  it("wire → domain（列表 / 详情读取）同样带上槽位", () => {
    const w = toUserWorkflow({
      id: "wf-1",
      name: "竞品调研",
      description: null,
      definition: WIRE_DEFINITION,
      version: 3,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T01:00:00Z",
    });
    expect(workflowSlotDefaults(w.definition)).toEqual({
      topic: "Notion 的协作功能",
    });
  });
});

describe("任务文本里的占位符", () => {
  it("切成文本段与槽位段，段起点可当稳定 key", () => {
    expect(splitSlotPlaceholders("调研 {{topic}} 的定价")).toEqual([
      { kind: "text", text: "调研 ", start: 0 },
      { kind: "slot", key: "topic", raw: "{{topic}}", start: 3 },
      { kind: "text", text: " 的定价", start: 12 },
    ]);
  });

  it("容忍花括号内空白，按出现顺序去重收集 key", () => {
    expect(slotKeysInText("{{ topic }} 与 {{angle}}，再看 {{topic}}")).toEqual([
      "topic",
      "angle",
    ]);
  });

  it("没有占位符时原样一段", () => {
    expect(splitSlotPlaceholders("写周报")).toEqual([
      { kind: "text", text: "写周报", start: 0 },
    ]);
    expect(slotKeysInText("写周报")).toEqual([]);
  });

  it("按默认值预览；没给值的占位符保持原样（服务端才是真渲染）", () => {
    expect(
      renderSlotText("调研 {{topic}} 与 {{unknown}}", { topic: "定价" }),
    ).toBe("调研 定价 与 {{unknown}}");
  });

  it("key 字符集与服务端逐字一致：认多了会把字面量画成变量胶囊", () => {
    // 服务端 workflows/slots.py 只认 [a-z][a-z0-9_]{0,23}。
    const rejected = [
      "{{Topic}}", // 大写开头
      "{{1topic}}", // 数字开头
      "{{my.key}}", // 带点
      "{{a-b}}", // 带连字符
      `{{${"a".repeat(25)}}}`, // 超过 24 位
    ];
    for (const text of rejected) {
      expect(slotKeysInText(text)).toEqual([]);
      expect(renderSlotText(text, { Topic: "x", a: "x" })).toBe(text);
    }
    expect(slotKeysInText("{{topic_2}} {{a}}")).toEqual(["topic_2", "a"]);
  });
});
