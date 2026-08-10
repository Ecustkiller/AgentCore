/** Minimal shapes shared by hot TeamPreviewDisplay and cold PendingResume. */

export type TeamPreviewWorkerView = {
  run_id: string;
  role: string;
  task: string;
  depends_on: string[];
  write_capability?: "text_only" | "can_write_files";
  write_capability_label?: string;
  /** CEO 提案模型 id（开工卡透出；人可盖）。 */
  model?: string;
  origin?: "platform" | "byok";
  provider_id?: string;
};

export type TeamPreviewSideView = {
  key: string;
  name: string;
  stance: string;
  is_subject?: boolean;
  /** 开赛前预分配；缺省 = 旧帧，不展示改模。 */
  run_id?: string;
  model?: string;
  origin?: "platform" | "byok";
  provider_id?: string;
};

export type TeamPreviewModelCandidateView = {
  model: string;
  origin: "platform" | "byok";
  provider_id?: string;
  label?: string;
  side_key?: string;
};

export type TeamPreviewDebateView = {
  motion: string;
  sides: readonly TeamPreviewSideView[];
  maxRounds: number;
  thorough: boolean;
  /** 裁判预分配 run_id；缺省 = 旧帧，不展示改模。 */
  moderatorRunId?: string;
  moderatorModel?: string;
  moderatorOrigin?: "platform" | "byok";
  moderatorProviderId?: string;
  sameModelDebate?: boolean;
  modelCandidates?: readonly TeamPreviewModelCandidateView[];
};
