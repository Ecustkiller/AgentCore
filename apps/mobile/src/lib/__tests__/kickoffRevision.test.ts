import { beforeEach, describe, expect, it } from "vitest";
import {
  clearColdInteractions,
  markColdResolved,
  upsertColdRequired,
} from "../coldInteractions";
import {
  KICKOFF_REVISION_META,
  diffKickoffRevision,
  kickoffRevisionHeadline,
  kickoffRevisionNumber,
  lookupPriorKickoffPayload,
  pickKickoffRevisionFields,
  showsKickoffRevision,
} from "../kickoffRevision";

beforeEach(() => {
  clearColdInteractions();
});

describe("kickoffRevision · parse", () => {
  it("缺省与非法值按首版 1，≥2 才显示版本标记", () => {
    expect(kickoffRevisionNumber(undefined)).toBe(1);
    expect(kickoffRevisionNumber(null)).toBe(1);
    expect(kickoffRevisionNumber(1)).toBe(1);
    expect(kickoffRevisionNumber(0)).toBe(1);
    expect(kickoffRevisionNumber(2)).toBe(2);
    expect(showsKickoffRevision(1)).toBe(false);
    expect(showsKickoffRevision(2)).toBe(true);
    expect(kickoffRevisionHeadline(2)).toBe("第 2 版 · 按你的意见修订");
  });

  it("pickKickoffRevisionFields 只透传有值的谱系", () => {
    expect(pickKickoffRevisionFields({})).toEqual({});
    expect(
      pickKickoffRevisionFields({
        revision: 2,
        revised_from: "tp1",
        revision_note: " 人太多，改成一个人做 ",
      }),
    ).toEqual({
      revision: 2,
      revised_from: "tp1",
      revision_note: "人太多，改成一个人做",
    });
  });
});

describe("kickoffRevision · lookup", () => {
  it("找不到上一版或 payload 为空 stub 时返回 null", () => {
    expect(lookupPriorKickoffPayload("tp-missing")).toBeNull();
    markColdResolved({
      kind: "team_preview",
      id: "tp-stub",
      resolution: { decision: "adjust" },
    });
    expect(lookupPriorKickoffPayload("tp-stub")).toBeNull();
  });

  it("已 resolved 且 payload 可用时返回上一版", () => {
    upsertColdRequired({
      kind: "team_preview",
      conversationId: "c1",
      messageId: "m1",
      payload: {
        checkpoint_id: "tp1",
        primitive: "delegate",
        workers: [{ run_id: "r1", role: "调研", task: "做A", depends_on: [] }],
      },
    });
    markColdResolved({
      kind: "team_preview",
      id: "tp1",
      resolution: { decision: "adjust", note: "改成一个人" },
    });
    const prior = lookupPriorKickoffPayload("tp1");
    expect(prior).not.toBeNull();
    expect((prior?.workers as { role?: string }[])[0]?.role).toBe("调研");
  });
});

describe("kickoffRevision · diff honesty", () => {
  it("prior 缺失返回空，不写无变化", () => {
    expect(
      diffKickoffRevision({ primitive: "delegate", workers: [] }, null),
    ).toEqual([]);
    expect(KICKOFF_REVISION_META.delegate.changesLead).toBe("相对上一版");
  });

  it("相对上一版相同则空列表，不编造无变化", () => {
    const same = {
      primitive: "delegate",
      workers: [
        {
          run_id: "r1",
          role: "调研",
          task: "做A",
          depends_on: [],
          write_capability: "text_only",
        },
      ],
    };
    expect(diffKickoffRevision(same, same)).toEqual([]);
  });

  it("delegate：成员增删、职责、写盘、计划步骤", () => {
    const prior = {
      primitive: "delegate",
      workers: [
        {
          run_id: "r1",
          role: "调研",
          task: "做A",
          depends_on: [],
          write_capability: "can_write_files",
        },
        {
          run_id: "r2",
          role: "审校",
          task: "做B",
          depends_on: ["r1"],
          write_capability: "text_only",
        },
      ],
    };
    const current = {
      primitive: "delegate",
      workers: [
        {
          run_id: "n1",
          role: "调研",
          task: "改做竞品",
          depends_on: [],
          write_capability: "text_only",
        },
        {
          run_id: "n2",
          role: "写作",
          task: "成稿",
          depends_on: ["n1"],
          write_capability: "can_write_files",
        },
      ],
    };
    const lines = diffKickoffRevision(current, prior);
    expect(lines).toContain("去掉 审校");
    expect(lines).toContain("新增 写作");
    expect(lines).toContain("调研：角色/职责有变");
    expect(lines).toContain("调研：写盘能力有变");
  });

  it("debate：辩题、立场、辩手", () => {
    const prior = {
      primitive: "debate",
      motion: "旧题",
      sides: [
        { key: "pro", name: "正方", stance: "赞成" },
        { key: "con", name: "反方", stance: "反对" },
      ],
    };
    const current = {
      primitive: "debate",
      motion: "新题",
      sides: [{ key: "pro", name: "正方", stance: "有条件赞成" }],
    };
    const lines = diffKickoffRevision(current, prior);
    expect(lines).toContain("辩题有变");
    expect(lines).toContain("去掉辩手 反方");
    expect(lines).toContain("正方：立场有变");
  });
});
