// @vitest-environment jsdom
/**
 * Render test for ToolLine 过程工具默认折叠: every process tool (web_search / code_execute /
 * file_write / str_replace / …) stays collapsed on the running→done edge — aligned with
 * Cursor/Claude「过程收敛、答案突出」. Folded rows keep inlineCount / peek; expand is a click
 * away. Failures also stay collapsed (red ✗ + red peek). The block comment detaches the
 * @vitest-environment directive from the import block so organizeImports keeps it file-leading.
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ProcessStep } from "@/types/events";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { toolGroupSummary } from "../message-bubble/constants";
import { ToolLine, ToolLineGroup } from "../ToolLine";

afterEach(cleanup);

function renderWithTooltip(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

type ToolStep = Extract<ProcessStep, { kind: "tool" }>;

function step(over: Partial<ToolStep>): ToolStep {
  return {
    kind: "tool",
    id: "call_1",
    tool_name: "code_execute",
    arguments: {},
    result: null,
    display: null,
    status: "success",
    ...over,
  };
}

function readUrlStep(
  id: string,
  over: {
    url: string;
    title: string;
    site: string;
    snippet?: string;
    content?: string;
    status?: ToolStep["status"];
  },
): ToolStep {
  return step({
    id,
    tool_name: "read_url",
    arguments: { url: over.url },
    result: "ok",
    display: {
      url: over.url,
      title: over.title,
      site: over.site,
      snippet: over.snippet,
      content: over.content ?? "正文不应出现在合并态",
    },
    status: over.status ?? "success",
  });
}

describe("ToolLine · 过程工具默认折叠", () => {
  it("keeps code_execute's terminal collapsed on the running→done edge", () => {
    const { rerender } = render(
      <ToolLine
        step={step({
          tool_name: "code_execute",
          arguments: { code: "print('hi')", language: "python" },
          status: "running",
        })}
      />,
    );
    // Running: nothing to expand yet — the terminal (退出码 badge) is absent.
    expect(screen.queryByText(/退出码 0/)).toBeNull();

    rerender(
      <ToolLine
        step={step({
          tool_name: "code_execute",
          arguments: { code: "print('hi')", language: "python" },
          result: "stdout:\nhello world",
          display: {
            stdout: "hello world\n",
            stderr: "",
            exit_code: 0,
            language: "python",
          },
          status: "success",
        })}
      />,
    );
    // Done: stays collapsed — 退出码 badge is expanded-only; peek shows stdout.
    expect(screen.queryByText(/退出码 0/)).toBeNull();
    expect(screen.getByText(/hello world/)).toBeTruthy();

    fireEvent.click(screen.getByText("执行代码"));
    expect(screen.getByText(/退出码 0/)).toBeTruthy();
  });

  it("keeps web_search results collapsed on completion", () => {
    const { rerender } = render(
      <ToolLine
        step={step({
          tool_name: "web_search",
          arguments: { query: "深圳天气" },
          status: "running",
        })}
      />,
    );
    // The hit title is expanded-only (while running only the query detail shows).
    expect(screen.queryByText("深圳天气预报")).toBeNull();

    rerender(
      <ToolLine
        step={step({
          tool_name: "web_search",
          arguments: { query: "深圳天气" },
          result: "1 条结果",
          display: {
            query: "深圳天气",
            results: [
              {
                title: "深圳天气预报",
                url: "https://w.example.com",
                site: "w.example.com",
                snippet: "多云转晴",
              },
            ],
          },
          status: "success",
        })}
      />,
    );
    // Collapsed: hit title hidden; click reveals the result card.
    expect(screen.queryByText("深圳天气预报")).toBeNull();
    fireEvent.click(screen.getByText("搜索网页"));
    expect(screen.getByText("深圳天气预报")).toBeTruthy();
  });

  it("inlines web_search result count into the title row when collapsed", () => {
    const { rerender } = render(
      <ToolLine
        step={step({
          tool_name: "web_search",
          arguments: { query: "深圳天气" },
          status: "running",
        })}
      />,
    );
    rerender(
      <ToolLine
        step={step({
          tool_name: "web_search",
          arguments: { query: "深圳天气" },
          result: "1 条结果",
          display: {
            query: "深圳天气",
            results: [
              {
                title: "深圳天气预报",
                url: "https://w.example.com",
                site: "w.example.com",
                snippet: "多云转晴",
              },
            ],
          },
          status: "success",
        })}
      />,
    );
    // Already collapsed by default — 计数并入标题行（对齐 read_url 组的「· N 个来源」），
    // 不再另起一行 peek；结果卡标题隐藏。
    expect(screen.getByText(/1 条结果/)).toBeTruthy();
    expect(screen.queryByText("深圳天气预报")).toBeNull();
  });

  it("keeps str_replace diff collapsed on the running→done edge", () => {
    const { rerender } = render(
      <ToolLine
        step={step({
          tool_name: "str_replace",
          arguments: {
            path: "src/foo.ts",
            old_string: "const x = 1",
            new_string: "const x = 2",
          },
          status: "running",
        })}
      />,
    );
    // Collapsed peek only — the diff's +/- counts are expanded-only.
    expect(screen.queryByText("+1")).toBeNull();

    rerender(
      <ToolLine
        step={step({
          tool_name: "str_replace",
          arguments: {
            path: "src/foo.ts",
            old_string: "const x = 1",
            new_string: "const x = 2",
          },
          result: "已编辑 src/foo.ts",
          status: "success",
        })}
      />,
    );
    expect(screen.queryByText("+1")).toBeNull();
    expect(screen.queryByText("-1")).toBeNull();

    fireEvent.click(screen.getByText("编辑文件"));
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
  });

  it("keeps file_write content card collapsed on the running→done edge", () => {
    const { rerender } = render(
      <ToolLine
        step={step({
          tool_name: "file_write",
          arguments: { path: "src/new.ts", content: "export const x = 1" },
          status: "running",
        })}
      />,
    );
    // Line-count footer is expanded-only (collapsed peek reads「已写入 …」).
    expect(screen.queryByText(/1 行 ·/)).toBeNull();

    rerender(
      <ToolLine
        step={step({
          tool_name: "file_write",
          arguments: { path: "src/new.ts", content: "export const x = 1" },
          result: "已写入 src/new.ts",
          status: "success",
        })}
      />,
    );
    expect(screen.queryByText(/1 行 ·/)).toBeNull();

    fireEvent.click(screen.getByText("写入文件"));
    expect(screen.getByText(/1 行 ·/)).toBeTruthy();
  });

  it("suppresses the peek for consult_memory — only the self-sufficient title shows", () => {
    const { rerender } = render(
      <ToolLine
        step={step({
          tool_name: "consult_memory",
          arguments: { name: "部署流程" },
          status: "running",
        })}
      />,
    );
    rerender(
      <ToolLine
        step={step({
          tool_name: "consult_memory",
          arguments: { name: "部署流程" },
          result: "用 pnpm dev 起前端",
          display: { topic: "部署流程" },
          status: "success",
        })}
      />,
    );
    // 查阅类工具的标题已自解释（查阅记忆 部署流程）、正文一键即达 → 折叠态不再另起 peek 行。
    // The note body (expanded-only) never renders, and the topic shows exactly once (the title
    // detail — no duplicate peek line echoing it).
    expect(screen.queryByText(/用 pnpm dev 起前端/)).toBeNull();
    expect(screen.getAllByText("部署流程")).toHaveLength(1);
  });

  it("suppresses the peek for consult_skill — the summary shows only when expanded", () => {
    render(
      <ToolLine
        step={step({
          tool_name: "consult_skill",
          arguments: { name: "debate_and_review" },
          result: "完整能力指引正文…",
          display: {
            skill_name: "debate_and_review",
            summary: "对需对抗性多视角思考的问题用 debate 工具发起结构化辩论",
          },
          status: "success",
        })}
      />,
    );
    // 折叠态只留标题（查阅能力 debate_and_review）——summary 不再作为 peek 行出现，展开卡片里才有。
    expect(screen.getByText("debate_and_review")).toBeTruthy();
    expect(
      screen.queryByText(/对需对抗性多视角思考的问题用 debate 工具/),
    ).toBeNull();
  });

  it("leaves read_url collapsed on completion (same default as every other tool)", () => {
    const { rerender } = render(
      <ToolLine
        step={step({
          tool_name: "read_url",
          arguments: { url: "https://weather.example.com/sz" },
          status: "running",
        })}
      />,
    );
    rerender(
      <ToolLine
        step={step({
          tool_name: "read_url",
          arguments: { url: "https://weather.example.com/sz" },
          result: '{"url":"…","title":"深圳天气","content":"正文"}',
          display: {
            url: "https://weather.example.com/sz",
            title: "深圳天气",
            site: "weather.example.com",
            snippet: "多云",
            content: "正文预览不应自动展开",
          },
          status: "success",
        })}
      />,
    );
    // Collapsed peek shows「标题 · 域名」; body stays hidden until the user expands.
    expect(screen.getByText("深圳天气 · weather.example.com")).toBeTruthy();
    expect(screen.queryByText(/正文预览不应自动展开/)).toBeNull();
  });
});

describe("ToolLineGroup · read_url 来源集合", () => {
  const sources = [
    readUrlStep("r1", {
      url: "https://zhuanlan.zhihu.com/p/1050596771_121124370",
      title: "相对论入门",
      site: "zhuanlan.zhihu.com",
      snippet: "时空弯曲简介",
    }),
    readUrlStep("r2", {
      url: "https://baike.baidu.com/item/相对论",
      title: "相对论_百度百科",
      site: "baike.baidu.com",
      snippet: "物理学理论",
    }),
  ];

  it("merges ≥2 read_url into a count-title header without collapsed pills", () => {
    renderWithTooltip(<ToolLineGroup tools={sources} isStreaming={false} />);
    expect(screen.getByText("读取网页 · 2 个来源")).toBeTruthy();
    // 折叠态收敛为纯标题行（对齐工具组 / 思考过程）——来源 pills 移到展开态，不再平铺。
    expect(screen.queryByText("zhuanlan.zhihu.com")).toBeNull();
    expect(screen.queryByText("baike.baidu.com")).toBeNull();
    // Merged view does not inline page bodies.
    expect(screen.queryByText(/正文不应出现在合并态/)).toBeNull();
  });

  it("expands to a SourceCards-style list without body content", () => {
    renderWithTooltip(<ToolLineGroup tools={sources} isStreaming={false} />);
    fireEvent.click(screen.getByText("读取网页 · 2 个来源"));
    expect(screen.getByText("相对论入门")).toBeTruthy();
    expect(screen.getByText("相对论")).toBeTruthy(); // cleanSourceTitle strips _百度百科
    expect(screen.getByText("时空弯曲简介")).toBeTruthy();
    // 来源域名在展开态才出现（折叠态已无 pills）。
    expect(screen.getByText("zhuanlan.zhihu.com")).toBeTruthy();
    expect(screen.queryByText(/正文不应出现在合并态/)).toBeNull();
  });

  it("leaves a mixed tool group on the default chevron path", () => {
    render(
      <ToolLineGroup
        tools={[
          sources[0],
          step({
            id: "s1",
            tool_name: "web_search",
            arguments: { query: "天气" },
            result: "1 条",
            status: "success",
          }),
        ]}
        isStreaming={false}
      />,
    );
    // Default group summary (not the source-collection header).
    expect(screen.queryByText("读取网页 · 2 个来源")).toBeNull();
    expect(screen.getByText(/读取网页 1 · 搜索网页 1/)).toBeTruthy();
  });
});

describe("toolGroupSummary · read_url", () => {
  it("uses a count title instead of URL basenames", () => {
    const tools = [
      step({
        id: "a",
        tool_name: "read_url",
        arguments: {
          url: "https://zhuanlan.zhihu.com/p/1050596771_121124370",
        },
      }),
      step({
        id: "b",
        tool_name: "read_url",
        arguments: { url: "https://baike.baidu.com/item/相对论" },
      }),
    ];
    expect(toolGroupSummary(tools)).toBe("读取网页 · 2 个来源");
    expect(toolGroupSummary(tools)).not.toMatch(/1050596771/);
  });

  it("keeps basename titles for other same-kind groups", () => {
    const tools = [
      step({
        id: "a",
        tool_name: "file_read",
        arguments: { path: "src/foo.ts" },
      }),
      step({
        id: "b",
        tool_name: "file_read",
        arguments: { path: "src/bar.ts" },
      }),
    ];
    expect(toolGroupSummary(tools)).toBe("读取文件 foo.ts · bar.ts");
  });
});
