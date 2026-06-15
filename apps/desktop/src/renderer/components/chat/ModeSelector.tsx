import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  patchConversationCache,
  useConversations,
} from "@/hooks/useConversations";
import { modeCostTier, modeRefLabel, presetLabel } from "@/lib/modelModes";
import { setConversationModelMode } from "@/services/modelModes";
import { useConversationStore } from "@/stores/conversation";
import { useModelModesStore } from "@/stores/modelModes";
import { Check, ChevronDown, Settings2, SlidersHorizontal } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Composer 质量档 picker (D2) — chooses which models the team uses for THIS
 * conversation, in 团队语言 (经济档 / 高质量档 / a custom mode), defaulting to
 * "跟随默认" (the account/operator default). A real conversation persists the
 * choice immediately (PATCH, optimistic); a fresh draft stashes it on the modes
 * store so the send path applies it at creation. Opens upward (`side="top"`) —
 * the composer sits at the bottom of the screen.
 */
export function ModeSelector({ disabled }: { disabled?: boolean }) {
  const navigate = useNavigate();

  const presets = useModelModesStore((s) => s.presets);
  const custom = useModelModesStore((s) => s.custom);
  const defaultMode = useModelModesStore((s) => s.defaultMode);
  const draftMode = useModelModesStore((s) => s.draftMode);
  const ensureLoaded = useModelModesStore((s) => s.ensureLoaded);

  const currentId = useConversationStore((s) => s.currentConversationId);
  const conversations = useConversations();
  const convMode = currentId
    ? (conversations.find((c) => c.id === currentId)?.modelMode ?? null)
    : null;

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  // The selection for the surface in view: a real conversation reads its own
  // (null = inherit); a fresh draft reads the pending draft selection.
  const selected = currentId ? convMode : draftMode;
  const triggerLabel =
    selected === null ? "跟随默认" : modeRefLabel(selected, custom);

  const choose = (mode: string | null) => {
    if (currentId) {
      // Optimistic, then persist. A write failure is non-fatal: the turn
      // resolver falls back safely, so we keep the optimistic value rather than
      // bouncing the UI.
      patchConversationCache(currentId, { modelMode: mode });
      void setConversationModelMode(currentId, mode).catch(() => {});
    } else {
      useModelModesStore.getState().setDraftMode(mode);
    }
  };

  const check = (active: boolean) =>
    active ? <Check size={14} className="shrink-0 text-primary" /> : null;

  return (
    <DropdownMenu>
      <SimpleTooltip label="质量档：为这次对话选择团队所用的模型">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="flex h-8 max-w-[180px] items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
          >
            <SlidersHorizontal size={14} className="shrink-0" />
            <span className="truncate">{triggerLabel}</span>
            <ChevronDown size={12} className="shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
      </SimpleTooltip>

      <DropdownMenuContent side="top" align="start" className="min-w-56">
        <DropdownMenuLabel>质量档</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => choose(null)}>
          <span className="flex-1 truncate">
            跟随默认（{modeRefLabel(defaultMode, custom)}）
          </span>
          {check(selected === null)}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {presets.map((p) => (
          <DropdownMenuItem key={p.key} onSelect={() => choose(p.key)}>
            <span className="flex-1 truncate">{presetLabel(p.key)}</span>
            <ModeTrailing
              assignments={p.assignments}
              active={selected === p.key}
            />
          </DropdownMenuItem>
        ))}
        {custom.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>我的质量档</DropdownMenuLabel>
            {custom.map((m) => (
              <DropdownMenuItem key={m.id} onSelect={() => choose(m.id)}>
                <span className="flex-1 truncate">{m.name}</span>
                <ModeTrailing
                  assignments={m.assignments}
                  active={selected === m.id}
                />
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/more/model-modes")}>
          <Settings2 size={14} className="shrink-0" />
          <span className="flex-1 truncate">管理质量档…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Trailing for a 质量档 menu item: relative-cost tag (same tiers as the settings
 *  page) + the active check, so cost is visible at the point of choosing. */
function ModeTrailing({
  assignments,
  active,
}: {
  assignments: Record<string, string>;
  active: boolean;
}) {
  const tier = modeCostTier(assignments);
  const tone =
    tier.level === "base"
      ? "text-muted-foreground"
      : tier.level === "mid"
        ? "text-info"
        : "text-warning";
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className={`text-xs ${tone}`}>{tier.label}</span>
      {active && <Check size={14} className="text-primary" />}
    </span>
  );
}
