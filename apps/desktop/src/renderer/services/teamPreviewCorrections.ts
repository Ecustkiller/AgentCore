/**
 * team_preview（delegate / debate）冷 resume continue 修正载荷。
 * 与 ResumeTurnRequest / SidecarResumeRequest 定案字段同形。
 */

/** Per-run model cover（人盖 CEO）；键 = run_id。 */
export type TeamPreviewModelOverride = {
  model: string;
  origin?: "platform" | "byok";
  provider_id?: string;
};

export interface TeamPreviewResumeCorrections {
  excluded_run_ids?: string[];
  write_capability_overrides?: Array<{
    run_id: string;
    capability: "text_only";
  }>;
  /** run_id → 模型三元组；空/缺 = 不改该节点。 */
  model_overrides?: Record<string, TeamPreviewModelOverride>;
}
