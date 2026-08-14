/**
 * User workflows REST client (定案 §10.6 / §10.7 / §10.8).
 *
 * Wire shapes hand-written; domain stays camelCase like `standingTasks`.
 * Official templates: GET /v1/workflow-playbook-templates；复制:
 * POST /v1/workflows/from-playbook. Templates 404/501 → empty list (UI hides section).
 * Slot definitions come from the backend catalog only — no local replica.
 *
 * 两处「槽位」不是一回事：`WorkflowTemplateSlot` 是官方模板复制时要填的参数目录；
 * definition 顶层的 `WorkflowSlot`（见 workflowDefinition.ts）是已存工作流里可换值的
 * 参数，跑一次时用它的 `default` 预填。
 */

import { ApiError, api } from "@/services/api";
import {
  type WorkflowDefinition,
  emptyWorkflowDefinition,
  parseWorkflowDefinition,
} from "@/services/workflowDefinition";
import {
  type WorkflowSource,
  parseWorkflowSource,
} from "@/services/workflowSource";

export interface UserWorkflow {
  id: string;
  name: string;
  description: string | null;
  definition: WorkflowDefinition;
  /** 出处（服务端权威字段，见 workflowSource.ts）；`null` = 不是固化来的。 */
  source: WorkflowSource | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string | null;
  definition?: WorkflowDefinition;
}

export interface PatchWorkflowInput {
  name?: string;
  description?: string | null;
  definition?: WorkflowDefinition;
}

export interface RunWorkflowInput {
  folderId: string;
  /** Optional per-run supplement (本轮补充). */
  note?: string | null;
  /**
   * 本轮槽位覆盖（key → 值）。只带用户改过的槽位：没带的 key 由服务端回落到
   * definition 里的 `default`，所以一个都不带 = 按固化那轮原样重跑。
   */
  slots?: Record<string, string>;
}

export interface RunWorkflowResult {
  conversationId: string | null;
}

/** One allowed value of an enumerated slot (render a picker, not a textbox). */
export interface WorkflowTemplateSlotChoice {
  value: string;
  label: string;
}

/** Official playbook template slot (domain) — mirrors the backend catalog. */
export interface WorkflowTemplateSlot {
  key: string;
  label: string;
  required: boolean;
  hint: string | null;
  /** Non-empty → only these values are accepted by the backend. */
  choices: WorkflowTemplateSlotChoice[];
}

/** Official playbook → copy-as-mine catalog entry (定案 §10.8). */
export interface WorkflowTemplate {
  id: string;
  title: string;
  summary: string;
  slots: WorkflowTemplateSlot[];
}

export interface FromPlaybookInput {
  playbook: string;
  /** Optional display name for the new user workflow. */
  name?: string | null;
  /** Primary slot values (topic / feature / task / app …). */
  slots: Record<string, string>;
}

/** Wire: snake_case — mirrors OpenAPI. */
export interface UserWorkflowWire {
  id: string;
  name: string;
  description?: string | null;
  definition: unknown;
  /** `WorkflowSummary` 顶层的出处；definition 里的同名键不再是它。 */
  source?: unknown;
  version: number;
  created_at: string;
  updated_at: string;
}

/** Wire: GET /v1/workflow-playbook-templates item. */
export interface WorkflowTemplateSlotChoiceWire {
  value?: string;
  label?: string;
}

export interface WorkflowTemplateSlotWire {
  key: string;
  label?: string;
  required?: boolean;
  hint?: string | null;
  choices?: WorkflowTemplateSlotChoiceWire[];
}

export interface WorkflowTemplateWire {
  id: string;
  title?: string;
  summary?: string;
  /** Prose one-liner for help copy; `slots` is the machine-readable source. */
  primary_slots?: string;
  slots?: WorkflowTemplateSlotWire[];
}

export function toUserWorkflow(w: UserWorkflowWire): UserWorkflow {
  return {
    id: w.id,
    name: w.name,
    description: w.description ?? null,
    definition: parseWorkflowDefinition(w.definition),
    source: parseWorkflowSource(w.source),
    version: w.version,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

function toTemplateSlotChoice(
  raw: WorkflowTemplateSlotChoiceWire,
): WorkflowTemplateSlotChoice {
  const value = String(raw.value ?? "").trim();
  return { value, label: raw.label?.trim() || value };
}

function toTemplateSlot(raw: WorkflowTemplateSlotWire): WorkflowTemplateSlot {
  const key = String(raw.key ?? "").trim();
  return {
    key,
    label: raw.label?.trim() || key,
    required: raw.required === true,
    hint: raw.hint?.trim() || null,
    choices: (raw.choices ?? [])
      .map(toTemplateSlotChoice)
      .filter((c) => c.value),
  };
}

export function toWorkflowTemplate(w: WorkflowTemplateWire): WorkflowTemplate {
  const id = String(w.id ?? "").trim();
  return {
    id,
    title: w.title?.trim() || id,
    summary: w.summary?.trim() ?? "",
    slots: (w.slots ?? []).map(toTemplateSlot).filter((s) => s.key),
  };
}

function isMissingRoute(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || e.status === 501);
}

/** List the signed-in user's workflows. */
export async function listWorkflows(): Promise<UserWorkflow[]> {
  const res = await api.get<UserWorkflowWire[]>("/v1/workflows");
  return (Array.isArray(res) ? res : []).map(toUserWorkflow);
}

export async function getWorkflow(id: string): Promise<UserWorkflow> {
  const res = await api.get<UserWorkflowWire>(
    `/v1/workflows/${encodeURIComponent(id)}`,
  );
  return toUserWorkflow(res);
}

export async function createWorkflow(
  input: CreateWorkflowInput,
): Promise<UserWorkflow> {
  const res = await api.post<UserWorkflowWire>("/v1/workflows", {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    definition: input.definition ?? emptyWorkflowDefinition(),
  });
  return toUserWorkflow(res);
}

export async function patchWorkflow(
  id: string,
  input: PatchWorkflowInput,
): Promise<UserWorkflow> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name.trim();
  if (input.description !== undefined) {
    const trimmed = input.description?.trim() || "";
    if (!trimmed) {
      body.clear_description = true;
    } else {
      body.description = trimmed;
    }
  }
  if (input.definition !== undefined) body.definition = input.definition;
  const res = await api.patch<UserWorkflowWire>(
    `/v1/workflows/${encodeURIComponent(id)}`,
    body,
  );
  return toUserWorkflow(res);
}

export async function deleteWorkflow(id: string): Promise<void> {
  await api.delete(`/v1/workflows/${encodeURIComponent(id)}`);
}

/** Run once: select workspace + optional note (+ slot overrides) → direct-start bypass. */
export async function runWorkflow(
  id: string,
  input: RunWorkflowInput,
): Promise<RunWorkflowResult> {
  const body: Record<string, unknown> = {
    folder_id: input.folderId,
    note: input.note?.trim() || null,
  };
  const slots: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.slots ?? {})) {
    const key = k.trim();
    const val = v.trim();
    if (key && val) slots[key] = val;
  }
  // 空覆盖不进 body：请求与「没有槽位的工作流」逐字一致。
  if (Object.keys(slots).length > 0) body.slots = slots;
  const res = await api.post<{ conversation_id?: string | null }>(
    `/v1/workflows/${encodeURIComponent(id)}/run`,
    body,
  );
  return { conversationId: res?.conversation_id ?? null };
}

/**
 * 按需抽出可换参数：返回这条工作流抽完后的最新形态（definition 里带上 slots，
 * 任务文本里的原值换成了 `{{key}}` 占位符）。
 *
 * 抽不出来时返回的 definition 与调用前逐字一致（仍然没有 slots）——这不是错误，
 * 照常直接跑即可。已有槽位时服务端幂等直接返回。抽取要真跑一次模型（最长约 20 秒），
 * 调用方须把它放在不挡用户的路径上。
 */
export async function suggestWorkflowSlots(id: string): Promise<UserWorkflow> {
  const res = await api.post<UserWorkflowWire>(
    `/v1/workflows/${encodeURIComponent(id)}/suggest-slots`,
  );
  return toUserWorkflow(res);
}

/** Lightweight list for standing-task binder (id + name only). */
export async function listWorkflowOptions(): Promise<
  Array<{ id: string; name: string }>
> {
  const list = await listWorkflows();
  return list.map((w) => ({ id: w.id, name: w.name }));
}

/**
 * Official playbook templates (只读目录).
 * Missing route (404/501) → empty list so UI can hide the section.
 * Path: GET /v1/workflow-playbook-templates (avoid clash with /workflows/{id}).
 */
export async function listWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  try {
    const res = await api.get<WorkflowTemplateWire[]>(
      "/v1/workflow-playbook-templates",
    );
    return (Array.isArray(res) ? res : [])
      .map(toWorkflowTemplate)
      .filter((t) => t.id);
  } catch (e) {
    if (isMissingRoute(e)) return [];
    throw e;
  }
}

/** Copy an official playbook into the signed-in user's workflows (使用 = 复制为我的). */
export async function createWorkflowFromPlaybook(
  input: FromPlaybookInput,
): Promise<UserWorkflow> {
  const slots: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.slots)) {
    const key = k.trim();
    const val = v.trim();
    if (key && val) slots[key] = val;
  }
  const body: Record<string, unknown> = {
    playbook: input.playbook.trim(),
    slots,
  };
  const name = input.name?.trim();
  if (name) body.name = name;
  const res = await api.post<UserWorkflowWire>(
    "/v1/workflows/from-playbook",
    body,
  );
  return toUserWorkflow(res);
}
