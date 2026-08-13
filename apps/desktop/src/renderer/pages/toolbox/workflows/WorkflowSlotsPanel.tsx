/**
 * 画布侧的「可换参数」面板：让固化出来的槽位在编辑器里看得见、改得了。
 *
 * 只改 `label` / `default`，其余槽位字段（后端可能加的）逐字保留——整份 definition
 * 会被原样 PATCH 回去。删槽位不做：任务文本里的 `{{key}}` 会当场变成没人认领的占位符。
 */

import { Button, Input, Textarea } from "@/components/ui";
import {
  type WorkflowDefinition,
  type WorkflowSlot,
  slotKeysInText,
  slotPlaceholder,
  workflowSlots,
} from "@/services/workflowDefinition";
import { Plus } from "lucide-react";

/** 引用了该 key 的队员步骤数（0 = 改它不影响任何一步）。 */
function usageCount(definition: WorkflowDefinition, key: string): number {
  return definition.nodes.filter(
    (n) => n.kind === "agent_step" && slotKeysInText(n.task).includes(key),
  ).length;
}

/** 任务里写了、但顶层没声明的占位符：跑一次时没人给它值。 */
function undeclaredKeys(definition: WorkflowDefinition): string[] {
  const declared = new Set(workflowSlots(definition).map((s) => s.key));
  const out: string[] = [];
  for (const node of definition.nodes) {
    if (node.kind !== "agent_step") continue;
    for (const key of slotKeysInText(node.task)) {
      if (!declared.has(key) && !out.includes(key)) out.push(key);
    }
  }
  return out;
}

function SlotRow({
  definition,
  slot,
  onPatch,
}: {
  definition: WorkflowDefinition;
  slot: WorkflowSlot;
  onPatch: (patch: Partial<WorkflowSlot>) => void;
}) {
  const used = usageCount(definition, slot.key);
  return (
    <div className="space-y-2 rounded-lg border border-border p-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <code className="rounded-lg bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
          {slotPlaceholder(slot.key)}
        </code>
        <span className="text-xs text-muted-foreground">
          {used > 0 ? `${used} 个步骤用到` : "没有步骤用到"}
        </span>
      </div>
      <label className="block" htmlFor={`wf-slot-label-${slot.key}`}>
        <span className="mb-1 block text-xs text-muted-foreground">名称</span>
        <Input
          id={`wf-slot-label-${slot.key}`}
          className="w-full"
          value={slot.label}
          maxLength={80}
          placeholder={slot.key}
          onChange={(e) => onPatch({ label: e.target.value })}
        />
      </label>
      <label className="block" htmlFor={`wf-slot-default-${slot.key}`}>
        <span className="mb-1 block text-xs text-muted-foreground">默认值</span>
        <Textarea
          id={`wf-slot-default-${slot.key}`}
          className="w-full text-sm"
          rows={2}
          value={slot.default}
          maxLength={4000}
          placeholder="跑一次时预填这个值"
          onChange={(e) => onPatch({ default: e.target.value })}
        />
      </label>
    </div>
  );
}

export function WorkflowSlotsPanel({
  definition,
  onChange,
}: {
  definition: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
}) {
  const slots = workflowSlots(definition);
  const orphans = undeclaredKeys(definition);

  const patchSlot = (key: string, patch: Partial<WorkflowSlot>) => {
    onChange({
      ...definition,
      slots: slots.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    });
  };

  const declare = (key: string) => {
    onChange({
      ...definition,
      slots: [...slots, { key, label: key, default: "" }],
    });
  };

  return (
    <section className="space-y-2 p-4">
      <div>
        <p className="text-sm font-medium text-foreground">可换参数</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {slots.length > 0
            ? "任务里的 {{参数}} 跑一次时会换成这里的值；默认值就是固化那轮的原话。"
            : "这个工作流没有可换参数，跑一次按图原样跑。任务里写 {{主题}} 这样的占位符即可登记一个。"}
        </p>
      </div>

      {slots.map((slot) => (
        <SlotRow
          key={slot.key}
          definition={definition}
          slot={slot}
          onPatch={(patch) => patchSlot(slot.key, patch)}
        />
      ))}

      {orphans.length > 0 && (
        <div className="space-y-2 rounded-lg border border-dashed border-border p-2.5">
          <p className="text-xs text-warning">
            任务里引用了未声明的参数，跑一次时不会被替换：
          </p>
          {orphans.map((key) => (
            <div key={key} className="flex items-center justify-between gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                {slotPlaceholder(key)}
              </code>
              <Button
                variant="neutral"
                size="sm"
                icon={<Plus size={12} />}
                onClick={() => declare(key)}
              >
                登记
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
