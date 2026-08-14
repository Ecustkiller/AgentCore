/**
 * 协作计数口径转出口（`formatCollabSummary`）。用户面已不渲染「互相把关」
 * （状态条 / 气泡脚都不挂）；实现与测试仍走 `@agentcore/protocol-fold-kit`，
 * 避免桌面再写一份句子。
 */
export {
  COLLAB_SUMMARY_TOOLTIP,
  formatCollabSummary,
} from "@agentcore/protocol-fold-kit";
