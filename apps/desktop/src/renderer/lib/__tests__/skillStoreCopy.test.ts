import {
  PUBLISH_MISSING_BODY,
  PUBLISH_MISSING_INTRO,
  publishBlockReason,
} from "@/lib/skillStoreCopy";
import { describe, expect, it } from "vitest";

describe("publishBlockReason", () => {
  it("缺介绍先拦", () => {
    expect(publishBlockReason("", "怎么审")).toBe(PUBLISH_MISSING_INTRO);
    expect(publishBlockReason("  ", "怎么审")).toBe(PUBLISH_MISSING_INTRO);
  });

  it("正文未加载不误判", () => {
    expect(publishBlockReason("审合同时用", "")).toBeNull();
    expect(publishBlockReason("审合同时用", undefined)).toBeNull();
  });

  it("有介绍无正文才拦空稿", () => {
    expect(
      publishBlockReason(
        "审合同时用",
        "---\napply: on_demand\ndescription: 审合同时用\n---\n",
      ),
    ).toBe(PUBLISH_MISSING_BODY);
  });

  it("介绍和正文都有则放行", () => {
    expect(publishBlockReason("审合同时用", "怎么审")).toBeNull();
  });
});
