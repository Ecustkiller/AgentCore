/**
 * organize_plan — 清单确认体：行式多选、默认全选（seedAllMultiple）。
 * 取消勾选即剔除。第二行从 op / 路径派生。卡头是批次标题，不画套话铬条。
 */
import { ASK_INTENT_META } from "@/components/chat/decision";
import type { CheckpointUserDecision } from "@/services/checkpoint";
import type { AskOption } from "@/types/events";
import { AskCardFooter, AskCardShell } from "./AskCardShell";
import { CommenceNote } from "./AskCommenceParts";
import { AskRowGroup } from "./AskOptionRow";
import type { AskUserContent, useAskAnswer } from "./AskUserFields";

const META = ASK_INTENT_META.organize_plan;

function summarizeOps(options: AskOption[]): string {
  let mkdir = 0;
  let move = 0;
  let copy = 0;
  let del = 0;
  for (const o of options) {
    const op = o.op;
    if (op === "mkdir") mkdir += 1;
    else if (op === "move") move += 1;
    else if (op === "copy") copy += 1;
    else if (op === "delete") del += 1;
  }
  const parts: string[] = [];
  if (mkdir) parts.push(`新建 ${mkdir} 个文件夹`);
  if (move) parts.push(`移动 ${move} 个文件`);
  if (copy) parts.push(`复制 ${copy} 个文件`);
  if (del) parts.push(`删除 ${del} 项（进回收站）`);
  return parts.length ? parts.join("、") : `${options.length} 项整理操作`;
}

function optionDetail(option: AskOption): string | undefined {
  const arrow =
    option.op === "move" || option.op === "copy"
      ? `${option.source ?? "?"} → ${option.destination ?? "?"}`
      : option.path
        ? `${option.op ?? "op"} ${option.path}`
        : null;
  return arrow ?? option.detail;
}

export function OrganizePlanBody({
  content,
  answer,
  busy,
  submitting,
  onContinue,
  onStop,
}: {
  content: AskUserContent;
  answer: ReturnType<typeof useAskAnswer>;
  busy: boolean;
  submitting: CheckpointUserDecision | null;
  onContinue: () => void;
  onStop: () => void;
}) {
  const q = content.questions[0];
  const picked = q ? (answer.answers[q.id] ?? []) : [];
  const overview = q ? summarizeOps(q.options) : "";
  const title = (q?.prompt || content.question).trim();

  const subtitle = overview ? `总览：${overview}` : undefined;

  return (
    <AskCardShell
      variant="organize_plan"
      title={title}
      subtitle={subtitle}
      footer={
        <AskCardFooter
          cta={picked.length > 0 ? `${META.cta}（${picked.length}）` : META.cta}
          ctaIcon={META.ctaIcon}
          busy={busy}
          submitting={submitting}
          onContinue={onContinue}
          onStop={onStop}
          ctaDisabled={picked.length === 0}
          hint="确认后按方案批量执行，不再二次弹审批；完成后可撤销本次 move/mkdir。"
        />
      }
    >
      <div className="space-y-3">
        {overview && (
          <p className="px-2 text-xs text-muted-foreground/80">
            敏感命名启发式默认已剔除，可勾回；非安全边界
          </p>
        )}

        {q && (
          <div>
            <p className="px-2 text-xs font-normal leading-snug text-muted-foreground">
              取消勾选即剔除
            </p>
            <AskRowGroup
              className="mt-1"
              multiple
              rows={q.options.map((opt) => ({
                key: opt.label,
                label: opt.label,
                detail: optionDetail(opt),
                selected: picked.includes(opt.label),
                disabled: busy,
                onSelect: () => answer.toggleChoice(q, opt.label),
              }))}
            />
          </div>
        )}

        <div className="px-2">
          {(q == null || q.kind === "choice") && (
            <CommenceNote
              answer={answer}
              questionId={q?.id}
              disabled={busy}
              compact
            />
          )}
        </div>
      </div>
    </AskCardShell>
  );
}
