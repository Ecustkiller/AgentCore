/**
 * team_preview（delegate）冷 resume continue 修正载荷。
 * 与 ResumeTurnRequest / SidecarResumeRequest 定案字段同形。
 */
export interface TeamPreviewResumeCorrections {
  excluded_run_ids?: string[];
  write_capability_overrides?: Array<{
    run_id: string;
    capability: "text_only";
  }>;
}
