// Desktop SSE 契约类型 = 共享单一源 @agentcore/contract-types 的 re-export（手机端落地
// 设计 §六 支柱2）。桌面已并入 workspace，本文件不再各自定义这些 wire 类型，改用
// `export type *` 透传共享单一源（纯类型，编译期 erase，运行时零引用 contract-types）。
// 后端加事件类型 → 改 contract-types 一处 → 桌面/手机两端编译失败直到处理（漂移绊线）。
//
// 仅保留 desktop 独有的「工具结果富渲染」narrow 类型：它们是桌面渲染层细节（手机精简端
// 不需要、不属于跨端 wire 契约），故留在本地而非下沉共享包。
export type * from "@agentcore/contract-types";

/** One web hit in a `web_search` tool's structured display (工具结果富渲染): a
 * result card's data (favicon via `site` · `title` · `snippet`). */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Display host (sans www.), parsed server-side so the card needs no URL work. */
  site?: string;
}

/** `web_search` rich result: the query + its hits, shown as source-style cards. */
export interface WebSearchDisplay {
  query: string;
  results: WebSearchHit[];
}

/** `read_url` rich result (工具结果富渲染): a single source-style card header
 * (favicon · title · site) plus the extracted page body for the expandable
 * preview. Mirrors citation fields so it visually aligns with WebSearchResult /
 * SourceCards; the client never parses the model-facing JSON `result`. */
export interface ReadUrlDisplay {
  url: string;
  title: string;
  /** Display host (sans www.), parsed server-side so the card needs no URL work. */
  site?: string;
  snippet?: string;
  /** Extracted main text (may be size-capped on the wire via `_cap_display`). */
  content: string;
}

/** `code_execute` rich result: a terminal-style stdout/stderr view + exit code. */
export interface CodeExecDisplay {
  stdout: string;
  stderr: string;
  exit_code: number;
  language: string;
}

/** `consult_skill` rich result (渐进披露 可视化): which system「能力」the CEO pulled
 * — its catalog `skill_name` + the one-line `summary`. The full guidance body rides
 * the `result` text (shown verbatim under this header), so the user sees exactly what
 * the model consulted. */
export interface SkillConsultDisplay {
  skill_name: string;
  summary: string;
}

/** `consult_memory` rich result (记忆文件夹化 §六 · 渐进披露 可视化): which 记忆主题笔记
 * the CEO pulled — its `topic` name. The full note body rides the `result` text (shown
 * verbatim under this header), so the user sees exactly which memory the model reached
 * for and what it read. */
export interface MemoryConsultDisplay {
  topic: string;
}
