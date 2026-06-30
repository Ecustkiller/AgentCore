import { Button, Textarea } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { notifyError } from "@/lib/toast";
import { sendDebateContinuation } from "@/services/turns";
import { useActiveGenerating } from "@/stores/conversation";
import { Loader2, Swords, X } from "lucide-react";
import { useState } from "react";
import type { DebateForm, DebateModel } from "./model";
import { projectDebateSeed } from "./seed";

/**
 * 续辩入口（结构化补轮·B / 可逆叫停，辩论编排设计.md §6.6）—— 收场辩论卡底部的
 * 「再辩一轮 / 换角度」。点开后可填一个可选角度，发起一个**新回合**：该回合携 `debate_seed`
 * （本场投影成的最小种子），引擎据此让新一场 debate 续上一场（主持人焦点正交于已谈、首轮辩手读到
 * 上一场摘要），从「读懂上一场」处接着往深里辩。
 *
 * 续辩是【新 turn = 新辩论卡】（守事件源 turn 模型，不原地改写上一场）。无实质内容可播种（旧 /
 * 扁平产物，{@link projectDebateSeed} 返 null）则不出此入口。回合进行中禁用（回合不叠加）。
 */
const CONTINUE_LABEL: Record<DebateForm, string> = {
  debate: "换个角度再辩一轮",
  red_team: "换个角度再审一轮",
  roundtable: "换个角度再探一轮",
};

export function DebateContinue({ model }: { model: DebateModel }) {
  const seed = projectDebateSeed(model);
  const generating = useActiveGenerating();
  const [open, setOpen] = useState(false);
  const [angle, setAngle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 无种子可播（旧 / 扁平辩论无逐轮摘要、无简报）→ 续辩无意义，不出入口。
  if (!seed) return null;

  const label = CONTINUE_LABEL[model.form] ?? CONTINUE_LABEL.debate;
  const motion = model.motion ?? model.rounds[0]?.focus ?? "上一场辩论";

  const submit = async (): Promise<void> => {
    if (submitting || generating) return;
    const trimmed = angle.trim();
    // 给 CEO 的续辩指令：点明原命题（让其沿用），种子另走 debate_seed 形参喂主持人/辩手。
    const content = trimmed
      ? `继续上一场关于「${motion}」的辩论，这次聚焦这个角度：${trimmed}。沿用同样的参与方再辩一轮。`
      : `继续上一场关于「${motion}」的辩论：换一个尚未谈透的角度，沿用同样的参与方再深入辩一轮。`;
    setSubmitting(true);
    try {
      const ok = await sendDebateContinuation(content, seed);
      if (ok) {
        setOpen(false);
        setAngle("");
      } else {
        notifyError(new Error("当前无法发起续辩"), "续辩未发起");
      }
    } catch (err) {
      notifyError(err, "续辩发起失败");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <div className="flex justify-center pt-1">
        <SimpleTooltip
          label={
            generating
              ? "回合进行中，结束后可续辩"
              : "就这场辩论换个角度再深入一轮"
          }
        >
          <Button
            variant="neutral"
            disabled={generating}
            onClick={() => setOpen(true)}
            icon={<Swords size={13} />}
          >
            {label}
          </Button>
        </SimpleTooltip>
      </div>
    );
  }

  return (
    <div className="animate-task-card-enter rounded-xl border border-border bg-card/60 p-3">
      <p className="text-xs font-medium text-foreground">续辩 ·「{motion}」</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        会另开一场新辩论接着上一场往深里辩（主持人换一个尚未谈透的焦点、辩手读得到上一场摘要）。
      </p>
      <Textarea
        value={angle}
        onChange={(e) => setAngle(e.target.value)}
        disabled={submitting}
        rows={2}
        placeholder="（可选）想换的角度；留空＝换一个尚未谈透的角度深入"
        className="mt-2 w-full border-border bg-card/70 focus:border-primary/60"
      />
      <div className="mt-2 flex items-center gap-1.5">
        <Button
          variant="primary"
          disabled={submitting || generating}
          onClick={() => void submit()}
          icon={
            submitting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Swords size={13} />
            )
          }
        >
          {angle.trim() ? "按此角度续辩" : "换角度续辩"}
        </Button>
        <Button
          variant="ghost"
          disabled={submitting}
          onClick={() => {
            setOpen(false);
            setAngle("");
          }}
          icon={<X size={13} />}
        >
          取消
        </Button>
      </div>
    </div>
  );
}
