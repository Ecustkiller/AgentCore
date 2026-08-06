/** Minimal shapes shared by hot TeamPreviewDisplay and cold PendingResume. */

export type TeamPreviewWorkerView = {
  run_id: string;
  role: string;
  task: string;
  depends_on: string[];
  write_capability?: "text_only" | "can_write_files";
  write_capability_label?: string;
};

export type TeamPreviewSideView = {
  key: string;
  name: string;
  stance: string;
  is_subject?: boolean;
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
  moderatorModel?: string;
  moderatorOrigin?: "platform" | "byok";
  sameModelDebate?: boolean;
  modelCandidates?: readonly TeamPreviewModelCandidateView[];
};
