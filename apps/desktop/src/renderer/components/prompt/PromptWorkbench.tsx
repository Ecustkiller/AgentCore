/**
 * 工具箱提示词工作台（预览 Markdown / 编辑 CodeMirror；可写停敲自动存）。
 * 顶栏放阅读切换与保存。封面只在编辑态、且有可编字段时出现。
 */

import {
  MarkdownSourceEditor,
  type MarkdownSourceEditorHandle,
} from "@/components/markdown/MarkdownSourceEditor";
import { SourceToolbar } from "@/components/markdown/sourceToolbar";
import {
  type BindableToolOption,
  OfferedToolsField,
} from "@/components/prompt/OfferedToolsField";
import { PromptDocument } from "@/components/prompt/PromptDocument";
import { Button, Input, SegmentedControl, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Loader2, Save } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export type { BindableToolOption };

export type PromptSaveState = "idle" | "saving" | "saved" | "error";
export type PromptApplyMode = "always" | "on_demand";

const APPLY_MODE_ITEMS = [
  { value: "always", label: "常驻" },
  { value: "on_demand", label: "按需" },
] as const;

const TITLE_LABEL = "名称";
const CATALOG_LINE_LABEL = "一句话介绍";
const CATALOG_LINE_PLACEHOLDER = "用一句话说这是什么";
const AUTOSAVE_DEBOUNCE_MS = 1500;

const TITLE_FIELD_CLASS =
  "h-auto min-h-8 w-full border-0 bg-transparent px-0 text-foreground focus:border-transparent focus-visible:ring-0";
const CATALOG_FIELD_CLASS =
  "h-auto min-h-8 w-full border-0 bg-transparent px-0 text-muted-foreground focus:border-transparent focus-visible:ring-0";

export interface PromptWorkbenchDraft {
  title: string;
  trigger: string;
  body: string;
  offeredTools: string[];
}

export function PromptWorkbench({
  title,
  titleEditable = false,
  badges,
  applyMode,
  onApplyModeChange,
  initialTrigger,
  triggerEnabled = false,
  initialOfferedTools,
  bindableTools,
  canAddOfferedTools = true,
  initialBody,
  bodyLoading = false,
  readOnly = false,
  extraActions,
  leading,
  previewing = false,
  testId,
  onSave,
}: {
  title: string;
  titleEditable?: boolean;
  badges?: ReactNode;
  /** `undefined` hides the 常驻 | 按需 switch. */
  applyMode?: PromptApplyMode;
  onApplyModeChange?: (mode: PromptApplyMode) => void;
  initialTrigger?: string;
  /** Show the catalog line (even when the seed is empty). */
  triggerEnabled?: boolean;
  initialOfferedTools?: string[];
  bindableTools?: BindableToolOption[];
  /** When false, only already-bound tools appear (no 添加). */
  canAddOfferedTools?: boolean;
  initialBody: string;
  bodyLoading?: boolean;
  readOnly?: boolean;
  extraActions?: ReactNode;
  /** Left of the save row (e.g. 预览 | 编辑). */
  leading?: ReactNode;
  previewing?: boolean;
  testId?: string;
  onSave?: (draft: PromptWorkbenchDraft) => Promise<boolean>;
}) {
  const titleId = useId();
  const catalogLineId = useId();
  const [titleValue, setTitleValue] = useState(title);
  const [trigger, setTrigger] = useState(initialTrigger ?? "");
  const [offeredTools, setOfferedTools] = useState<string[]>(
    initialOfferedTools ?? [],
  );
  const [body, setBody] = useState(initialBody);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<PromptSaveState>("idle");
  const editorRef = useRef<MarkdownSourceEditorHandle>(null);
  const latestRef = useRef<PromptWorkbenchDraft>({
    title,
    trigger: initialTrigger ?? "",
    body: initialBody,
    offeredTools: initialOfferedTools ?? [],
  });
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => void>(() => {});

  latestRef.current = {
    title: titleValue,
    trigger,
    offeredTools,
    body,
  };
  dirtyRef.current = dirty;

  const clearAutosave = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  const doSave = useCallback(async () => {
    if (readOnly || !onSave || savingRef.current) return;
    const md = editorRef.current?.getValue() ?? latestRef.current.body;
    const draft: PromptWorkbenchDraft = { ...latestRef.current, body: md };
    latestRef.current = draft;
    setBody(md);
    if (!dirtyRef.current) return;
    clearAutosave();
    savingRef.current = true;
    setSaveState("saving");
    try {
      const ok = await onSave(draft);
      if (ok) {
        dirtyRef.current = false;
        setDirty(false);
        setSaveState("saved");
      } else {
        setSaveState("error");
      }
    } finally {
      savingRef.current = false;
    }
  }, [onSave, readOnly, clearAutosave]);

  const markDirty = useCallback(
    (patch: Partial<PromptWorkbenchDraft>) => {
      if (readOnly) return;
      latestRef.current = { ...latestRef.current, ...patch };
      dirtyRef.current = true;
      setDirty(true);
      setSaveState("idle");
      clearAutosave();
      autosaveTimerRef.current = setTimeout(() => {
        void doSave();
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [doSave, readOnly, clearAutosave],
  );

  useEffect(() => {
    if (saveState !== "saved") return;
    const id = setTimeout(
      () => setSaveState((s) => (s === "saved" ? "idle" : s)),
      2500,
    );
    return () => clearTimeout(id);
  }, [saveState]);

  useEffect(() => {
    flushRef.current = () => {
      if (savingRef.current || !dirtyRef.current || readOnly || !onSave) return;
      const md = editorRef.current?.getValue() ?? latestRef.current.body;
      void onSave({ ...latestRef.current, body: md });
    };
  }, [onSave, readOnly]);

  useEffect(
    () => () => {
      clearAutosave();
      flushRef.current();
    },
    [clearAutosave],
  );

  useEffect(() => {
    const onBeforeUnload = () => flushRef.current();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const showCatalogLine = applyMode !== "always" && triggerEnabled;
  const showTitleRow = titleEditable || applyMode !== undefined;
  const offerOptions = offeredToolOptions(bindableTools ?? [], offeredTools);
  const showOfferedTools =
    offeredTools.length > 0 || (canAddOfferedTools && offerOptions.length > 0);
  const showCover =
    !previewing && (showTitleRow || showCatalogLine || showOfferedTools);
  const triggerText = trigger.trim();
  const showSave = Boolean(!readOnly && onSave && (!previewing || dirty));

  const cover = showCover ? (
    <div className="mx-auto w-full max-w-3xl px-6 pt-5 pb-4">
      {showTitleRow ? (
        <div className="flex flex-wrap items-start gap-3">
          {titleEditable ? (
            <label
              htmlFor={titleId}
              className="flex min-w-0 flex-1 items-baseline gap-2"
            >
              <span className="shrink-0 text-muted-foreground text-xs">
                {TITLE_LABEL}
              </span>
              <Input
                id={titleId}
                aria-label={TITLE_LABEL}
                value={titleValue}
                onChange={(event) => {
                  const next = event.target.value;
                  setTitleValue(next);
                  markDirty({ title: next });
                }}
                disabled={readOnly}
                className={cn(TITLE_FIELD_CLASS, "min-w-0 flex-1")}
              />
            </label>
          ) : null}
          {applyMode !== undefined ? (
            <SegmentedControl
              aria-label="加载方式"
              value={applyMode}
              onChange={(next) => onApplyModeChange?.(next)}
              items={APPLY_MODE_ITEMS}
              className="w-auto shrink-0"
            />
          ) : null}
        </div>
      ) : null}
      {showCatalogLine ? (
        readOnly ? (
          <div
            className={cn(
              showTitleRow && "mt-2",
              "flex min-w-0 items-start gap-2",
            )}
          >
            <span className="shrink-0 pt-1.5 text-muted-foreground text-xs">
              {CATALOG_LINE_LABEL}
            </span>
            <span className="min-w-0 whitespace-pre-wrap text-muted-foreground text-sm">
              {triggerText || CATALOG_LINE_PLACEHOLDER}
            </span>
          </div>
        ) : (
          <label
            htmlFor={catalogLineId}
            className={cn(
              showTitleRow && "mt-2",
              "flex min-w-0 items-start gap-2",
            )}
          >
            <span className="shrink-0 pt-1.5 text-muted-foreground text-xs">
              {CATALOG_LINE_LABEL}
            </span>
            <Textarea
              id={catalogLineId}
              aria-label={CATALOG_LINE_LABEL}
              placeholder={CATALOG_LINE_PLACEHOLDER}
              rows={2}
              value={trigger}
              onChange={(event) => {
                const next = event.target.value;
                setTrigger(next);
                markDirty({ trigger: next });
              }}
              className={cn(
                CATALOG_FIELD_CLASS,
                "min-h-8 min-w-0 flex-1 text-sm",
              )}
            />
          </label>
        )
      ) : null}
      {showOfferedTools ? (
        <div className={cn((showTitleRow || showCatalogLine) && "mt-3")}>
          <OfferedToolsField
            selected={offeredTools}
            options={offerOptions}
            canAdd={canAddOfferedTools}
            readOnly={readOnly}
            onChange={(next) => {
              setOfferedTools(next);
              markDirty({ offeredTools: next });
            }}
          />
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid={testId}
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3">
        {leading}
        {badges}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {dirty ? (
            <span className="shrink-0 text-primary text-xs">●</span>
          ) : null}
          {saveState === "saving" ? (
            <span className="text-muted-foreground text-xs">保存中…</span>
          ) : null}
          {saveState === "saved" && !dirty ? (
            <span className="text-muted-foreground text-xs">已保存</span>
          ) : null}
          {extraActions}
          {showSave ? (
            <Button
              className="shrink-0 disabled:opacity-50"
              disabled={!dirty || saveState === "saving"}
              onClick={() => void doSave()}
              icon={
                saveState === "saving" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Save size={13} />
                )
              }
            >
              保存
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {bodyLoading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
            加载中…
          </div>
        ) : previewing ? (
          <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
            {body.trim() ? (
              <PromptDocument
                text={body}
                compact={false}
                framed={false}
                maxHeightClass="max-h-none"
              />
            ) : (
              <p className="text-muted-foreground text-sm">还没有正文</p>
            )}
          </div>
        ) : (
          <>
            {cover ? (
              <div className="max-h-[12rem] shrink-0 overflow-y-auto border-b border-border">
                {cover}
              </div>
            ) : null}
            <div className="flex min-h-[16rem] min-w-0 flex-1 flex-col overflow-hidden">
              {!readOnly ? (
                <SourceToolbar
                  getView={() => editorRef.current?.getView() ?? null}
                />
              ) : null}
              <div className="min-h-0 flex-1 overflow-hidden">
                <MarkdownSourceEditor
                  ref={editorRef}
                  initialDoc={body}
                  editable={!readOnly}
                  onChange={(value) => {
                    setBody(value);
                    markDirty({ body: value });
                  }}
                  onSave={() => void doSave()}
                  className="h-full w-full"
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function offeredToolOptions(
  bindable: BindableToolOption[],
  selected: string[],
): BindableToolOption[] {
  if (bindable.length === 0 && selected.length === 0) return [];
  const known = new Set(bindable.map((tool) => tool.id));
  const extra = selected
    .filter((id) => !known.has(id))
    .map((id) => ({ id, label: id }));
  return extra.length ? [...bindable, ...extra] : bindable;
}
