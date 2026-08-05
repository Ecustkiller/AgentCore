import { describe, expect, it } from "vitest";
import {
  NOTICE_TEMPLATES,
  buildFromSlots,
  emptySlotValues,
  surfacePublishHint,
  templateToFormSeed,
} from "../noticeTemplates";

describe("noticeTemplates", () => {
  it("exposes nine operational templates with required fields", () => {
    expect(NOTICE_TEMPLATES).toHaveLength(9);
    for (const t of NOTICE_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.title.trim().length).toBeGreaterThan(0);
      expect(t.body.trim().length).toBeGreaterThan(0);
      expect(t.slots.length).toBeGreaterThan(0);
      expect(["critical", "high", "normal"]).toContain(t.severity);
      expect(["banner", "inbox", "both", "modal"]).toContain(t.surface);
      expect(["once", "never"]).toContain(t.dismiss_policy);
    }
  });

  it("never pairs modal with dismiss=never", () => {
    for (const t of NOTICE_TEMPLATES) {
      if (t.surface === "modal") {
        expect(t.dismiss_policy).toBe("once");
      }
    }
  });

  it("templateToFormSeed copies recommended fields and clears CTA/window", () => {
    const seed = templateToFormSeed(NOTICE_TEMPLATES[0]!);
    expect(seed.title).toBe(NOTICE_TEMPLATES[0]!.title);
    expect(seed.severity).toBe(NOTICE_TEMPLATES[0]!.severity);
    expect(seed.cta_label).toBe("");
    expect(seed.end_at).toBe("");
  });

  it("quota_jiurelay seeds jiurelay CTA and fixed copy", () => {
    const t = NOTICE_TEMPLATES.find((x) => x.id === "quota_jiurelay")!;
    expect(t).toBeTruthy();
    const seed = templateToFormSeed(t);
    expect(seed.title).toBe("平台额度暂时不可用 · 请免费自配 jiurelay");
    expect(seed.body).toContain("免费自行配额度");
    expect(seed.body).toContain("设置 · 服务商");
    expect(seed.body).not.toMatch(/注册|充值/);
    expect(seed.cta_label).toBe("前往 jiurelay 免费配额");
    expect(seed.cta_url).toBe("https://jiurelay.com/");
    expect(seed.surface).toBe("both");
    const withNote = buildFromSlots(t, { note: "预计明日恢复" });
    expect(withNote.body).toContain("补充：预计明日恢复");
  });

  it("buildFromSlots fills hotfix copy from slot values", () => {
    const hotfix = NOTICE_TEMPLATES.find((t) => t.id === "hotfix")!;
    const built = buildFromSlots(hotfix, {
      time: "14:30",
      summary: "修复消息发送超时",
    });
    expect(built.title).toBe(
      "约 14:30 更新 · 请按需规划好时间 · 提前停止使用 AI 功能",
    );
    expect(built.body).toContain("今天约 14:30");
    expect(built.body).toContain("修复消息发送超时");
  });

  it("buildFromSlots keeps skeleton when slots empty", () => {
    const hotfix = NOTICE_TEMPLATES.find((t) => t.id === "hotfix")!;
    const built = buildFromSlots(hotfix, emptySlotValues(hotfix));
    expect(built.title).toContain("HH:MM");
    expect(built.body).toContain("一句话变更摘要");
  });

  it("buildFromSlots formats release highlights as numbered lines", () => {
    const release = NOTICE_TEMPLATES.find((t) => t.id === "release")!;
    const built = buildFromSlots(release, {
      version: "0.4.2",
      time: "10:00",
      highlights: "消息编辑\n撤回优化\n多余行应被截断\n不会出现",
    });
    expect(built.title).toBe(
      "约 10:00 发版 · 请按需规划好时间 · 提前停止使用 AI 功能",
    );
    expect(built.body).toContain("1. 消息编辑");
    expect(built.body).toContain("2. 撤回优化");
    expect(built.body).toContain("3. 多余行应被截断");
    expect(built.body).not.toContain("不会出现");
  });

  it("surfacePublishHint warns on invalid modal+never", () => {
    expect(surfacePublishHint("modal", "never")).toMatch(/仅支持/);
    expect(surfacePublishHint("both", "once")).toMatch(/横幅/);
    expect(surfacePublishHint("both", "once")).toMatch(/官方/);
  });
});
