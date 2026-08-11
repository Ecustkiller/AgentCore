import { modelConfigApiErrorMessage } from "@/components/llm/ModelKeyForm";
import { Button, Card, IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useLlmModelProfiles } from "@/hooks/useLlmModelProfiles";
import { useLlmProviders } from "@/hooks/useLlmProviders";
import { useModels } from "@/hooks/useModels";
import {
  type DefaultProviderGroup,
  buildDefaultProviderGroups,
  decodePointer,
  encodePointer,
  pointerValue,
} from "@/lib/llmDefaults";
import {
  llmModelProfileKeys,
  llmProviderKeys,
  modelKeys,
} from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import {
  type CreateLlmModelProfileInput,
  type LlmModelProfileView,
  type ModelProfileSlot,
  createLlmModelProfile,
  deleteLlmModelProfile,
  profileSlotSummary,
  setDefaultLlmModelProfile,
  updateLlmModelProfile,
} from "@/services/llmModelProfiles";
import type { LlmProviderView } from "@/services/llmProviders";
import { type ModelCatalogItem, findCatalogItem } from "@/services/models";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Copy, Loader2, Plus, Star, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ProfileModelSelect, canChooseFromGroups } from "./ProfileModelSelect";
import { SettingsHeader } from "./SettingsHeader";

/** 草稿主模型是否在 curated 目录标有 vision（贴图可直送主模型）。 */
function mainHasCuratedVision(
  main: ModelProfileSlot | null,
  catalogModels: ModelCatalogItem[],
): boolean {
  if (!main) return false;
  const item = findCatalogItem(catalogModels, {
    id: main.model,
    origin: main.origin,
    providerId: main.provider_id,
  });
  return (item?.capabilities ?? []).includes("vision");
}

/** 从分组取第一个可选槽（平台或 BYOK），用于新建种子。 */
function firstSlotFromGroups(
  groups: DefaultProviderGroup[],
): ModelProfileSlot | null {
  for (const g of groups) {
    const m = g.models[0];
    if (!m) continue;
    return decodePointer(encodePointer(g.providerId, m.model));
  }
  return null;
}

/**
 * 无可选模型时的引导。
 * 平台可用：稍后重试 / 去设置检查（不硬推第三方）。
 * 平台不可用：jiurelay 免费配额度或接入服务商。
 */
function NoAvailableModelsGuide({
  className,
  platformAvailable,
}: {
  className?: string;
  platformAvailable: boolean;
}) {
  if (platformAvailable) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        暂无可用模型。请稍后重试，或到{" "}
        <Link
          to="/more/providers"
          className="text-primary underline-offset-2 hover:underline"
        >
          设置 · 服务商
        </Link>{" "}
        检查配置。
      </p>
    );
  }
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      暂无可用模型。请到{" "}
      <a
        href="https://jiurelay.com/"
        target="_blank"
        rel="noreferrer"
        className="text-primary underline-offset-2 hover:underline"
      >
        jiurelay
      </a>{" "}
      免费配额度，或{" "}
      <Link
        to="/more/providers"
        className="text-primary underline-offset-2 hover:underline"
      >
        接入服务商
      </Link>
      。
    </p>
  );
}

/**
 * 模型 (/more/model) — 账号默认组合 + 组合 CRUD。
 *
 * 组合 = `{ main, worker?, background?, vision? }`；账号默认组合与会话引用见
 * `/v1/users/me/llm-model-profiles`。凭据与测连见 `/more/providers`。
 */

/** 识图槽：优先只列 catalog 带 `vision` capability 的项；过滤为空则回退全目录。 */
function catalogForVisionSlot(
  catalog: ReturnType<typeof useModels>["data"],
): ReturnType<typeof useModels>["data"] {
  if (!catalog) return catalog;
  const visionModels = catalog.models.filter((m) =>
    (m.capabilities ?? []).includes("vision"),
  );
  if (visionModels.length === 0) return catalog;
  return { ...catalog, models: visionModels };
}

/**
 * 识图下拉分组。过滤命中时去掉 provider.default_model，避免无 vision 的默认项渗入；
 * 过滤为空时与主槽同形（全目录 + BYOK 手填）。
 */
function buildVisionProviderGroups(
  providers: LlmProviderView[],
  catalog: ReturnType<typeof useModels>["data"],
  ...slots: (ModelProfileSlot | null | undefined)[]
): DefaultProviderGroup[] {
  const visionCatalog = catalogForVisionSlot(catalog);
  const filtered = visionCatalog !== catalog;
  const providersForVision = filtered
    ? providers.map((p) => ({ ...p, default_model: "" }))
    : providers;
  return buildDefaultProviderGroups(
    providersForVision,
    visionCatalog,
    ...slots,
  );
}

export function ModelSettings() {
  const { data: response, isLoading, isError, error } = useLlmProviders();
  const { data: catalog } = useModels();
  const queryClient = useQueryClient();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: llmProviderKeys.list });
    void queryClient.invalidateQueries({ queryKey: modelKeys.catalog });
    void queryClient.invalidateQueries({ queryKey: llmModelProfileKeys.list });
  };

  const providers = response?.providers ?? [];
  const platformAvailable = response?.platform_available ?? false;
  const canEditProfiles = providers.length > 0 || platformAvailable;

  return (
    <div>
      <SettingsHeader
        title="模型"
        description={
          platformAvailable
            ? "选择账号默认组合（主模型 + 可选组队队员 / 后台 / 识图）。可用平台额度直接对话，也可接入服务商。"
            : "选择账号默认组合（主模型 + 可选组队队员 / 后台 / 识图）。需自行在 jiurelay 免费配额度或接入服务商。"
        }
      />

      {isLoading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
          加载中…
        </div>
      ) : isError || !response ? (
        <p className="mt-6 text-sm text-destructive">
          {modelConfigApiErrorMessage(error, "加载失败，请重试")}
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          <PlatformStatusLine
            platformAvailable={platformAvailable}
            platformModel={response.platform_model ?? null}
            hasProviders={providers.length > 0}
          />

          {canEditProfiles ? (
            <ModelProfilesSection
              providers={providers}
              catalog={catalog}
              platformAvailable={platformAvailable}
              onChanged={refresh}
            />
          ) : (
            <EmptyProfilesCta />
          )}
        </div>
      )}
    </div>
  );
}

function EmptyProfilesCta() {
  const navigate = useNavigate();
  return (
    <Card className="flex flex-col items-center justify-center gap-3 border-dashed py-8 text-center">
      <p className="text-sm text-muted-foreground">
        还没有可用模型。请到{" "}
        <a
          href="https://jiurelay.com/"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-2 hover:underline"
        >
          jiurelay
        </a>{" "}
        免费配额度，或接入服务商。
      </p>
      <Button
        size="sm"
        icon={<Plus size={14} />}
        onClick={() => navigate("/more/providers")}
      >
        接入服务商
      </Button>
    </Card>
  );
}

function PlatformStatusLine({
  platformAvailable,
  platformModel,
  hasProviders,
}: {
  platformAvailable: boolean;
  platformModel: string | null;
  hasProviders: boolean;
}) {
  if (!platformAvailable && hasProviders) {
    return (
      <p className="text-xs text-muted-foreground">
        已接入服务商。{" "}
        <Link
          to="/more/providers"
          className="text-primary underline-offset-2 hover:underline"
        >
          管理服务商
        </Link>
      </p>
    );
  }
  if (!platformAvailable) return null;

  const modelHint = platformModel ? ` · ${platformModel}` : "";

  return (
    <p className="text-xs text-muted-foreground">
      可用平台额度
      {modelHint}。{" "}
      <Link
        to="/more/providers"
        className="text-primary underline-offset-2 hover:underline"
      >
        {hasProviders ? "管理服务商" : "接入服务商"}
      </Link>
    </p>
  );
}

/**
 * 模型组合列表 + 编辑：主必填；组队队员 / 后台 / 识图收进「高级 · 其他模型」
 * （有覆盖时默认展开）。组队/后台空 = 跟随主模型；识图空 = 不配置（不 follow main）。
 * 系统预置不可删，可设默认 / 复制为用户组合；用户组合可新建 / 改名 / 删。
 */
function ModelProfilesSection({
  providers,
  catalog,
  platformAvailable,
  onChanged,
}: {
  providers: LlmProviderView[];
  catalog: ReturnType<typeof useModels>["data"];
  platformAvailable: boolean;
  onChanged: () => void;
}) {
  const {
    data: profileList,
    isLoading,
    isError,
    error,
  } = useLlmModelProfiles();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<ReactNode>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const catalogModels = catalog?.models ?? [];
  const manageable = useMemo(
    () =>
      (profileList?.data ?? []).filter(
        (p) => p.kind === "system" || p.kind === "user",
      ),
    [profileList],
  );

  // 仅用于新建种子 / 空目录引导；编辑卡内按当前组合槽位 fold-in。
  const seedGroups = buildDefaultProviderGroups(providers, catalog);

  const seedMain = (): ModelProfileSlot | null => {
    const cur = catalog?.current;
    if (cur?.id) {
      return {
        origin: cur.origin,
        provider_id: cur.provider_id ?? null,
        model: cur.id,
      };
    }
    const first = catalogModels.find((m) => m.available !== false);
    if (first) {
      return {
        origin: first.origin,
        provider_id: first.provider_id ?? null,
        model: first.id,
      };
    }
    return firstSlotFromGroups(seedGroups);
  };

  const withPending = async (fn: () => Promise<void>) => {
    setPending(true);
    setActionError(null);
    setSaveSuccess(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setActionError(modelConfigApiErrorMessage(e, "操作失败，请重试"));
    } finally {
      setPending(false);
    }
  };

  const onSetDefault = (profile: LlmModelProfileView) =>
    withPending(async () => {
      await setDefaultLlmModelProfile(profile.id);
      setSaveSuccess(`已将「${profile.name}」设为默认组合`);
    });

  const onDelete = (profile: LlmModelProfileView) => {
    if (profile.kind !== "user") return;
    if (
      !window.confirm(
        `删除组合「${profile.name}」？引用该组合的会话将回落账号默认。`,
      )
    )
      return;
    void withPending(async () => {
      await deleteLlmModelProfile(profile.id);
      if (editingId === profile.id) setEditingId(null);
      setSaveSuccess(`已删除「${profile.name}」`);
    });
  };

  const onCopy = (profile: LlmModelProfileView) =>
    withPending(async () => {
      const created = await createLlmModelProfile({
        name: `${profile.name} 副本`,
        main: profile.main,
        worker: profile.worker ?? null,
        background: profile.background ?? null,
        vision: profile.vision ?? null,
        set_as_default: false,
      });
      setEditingId(created.id);
      setCreating(false);
      setSaveSuccess(`已复制为「${created.name}」`);
    });

  const onCreate = () => {
    const main = seedMain();
    // 无目录种子时：有 BYOK 仍可开编辑器手填；仅平台空目录 / 无服务商才拦。
    if (!main && providers.length === 0) {
      setActionError(
        <NoAvailableModelsGuide platformAvailable={platformAvailable} />,
      );
      return;
    }
    setActionError(null);
    setSaveSuccess(null);
    setCreating(true);
    setEditingId(null);
  };

  const onSaveCreate = async (draft: ProfileDraft) => {
    if (!draft.main) throw new Error("主模型必填");
    setPending(true);
    try {
      await createLlmModelProfile({
        name: draft.name.trim() || "未命名组合",
        main: draft.main,
        worker: draft.worker,
        background: draft.background,
        vision: draft.vision,
        set_as_default: false,
      } satisfies CreateLlmModelProfileInput);
      setCreating(false);
      setEditingId(null);
      setSaveSuccess("组合已保存");
      onChanged();
    } finally {
      setPending(false);
    }
  };

  const onSaveEdit = async (
    profile: LlmModelProfileView,
    draft: ProfileDraft,
  ) => {
    if (profile.kind !== "user") return;
    if (!draft.main) throw new Error("主模型必填");
    setPending(true);
    try {
      const name = draft.name.trim() || profile.name;
      await updateLlmModelProfile(profile.id, {
        name,
        main: draft.main,
        worker: draft.worker,
        background: draft.background,
        vision: draft.vision,
      });
      setEditingId(null);
      setSaveSuccess(`「${name}」已保存`);
      onChanged();
    } finally {
      setPending(false);
    }
  };

  return (
    <section>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">模型组合</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            主模型必填；组队队员 /
            后台可留空跟随；识图可留空不配置。改定义后下一回合生效。
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            多人协作（委派）对工具调用要求较高；若失败可换更稳的主模型，或改用手写{" "}
            <code className="text-xs">tasks</code>。
          </p>
        </div>
        <Button
          variant="neutral"
          size="sm"
          icon={<Plus size={14} />}
          disabled={pending}
          onClick={onCreate}
        >
          新建
        </Button>
      </div>

      {isLoading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          加载组合…
        </div>
      ) : isError ? (
        <p className="mt-3 text-xs text-destructive">
          {modelConfigApiErrorMessage(error, "加载组合失败")}
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {creating && (
            <ProfileEditor
              title="新建组合"
              providers={providers}
              catalog={catalog}
              catalogModels={catalogModels}
              platformAvailable={platformAvailable}
              initial={{
                name: "未命名组合",
                main: seedMain(),
                worker: null,
                background: null,
                vision: null,
              }}
              pending={pending}
              onCancel={() => setCreating(false)}
              onSave={onSaveCreate}
            />
          )}

          {manageable.map((profile) =>
            editingId === profile.id && profile.kind === "user" ? (
              <ProfileEditor
                key={profile.id}
                title="编辑组合"
                providers={providers}
                catalog={catalog}
                catalogModels={catalogModels}
                platformAvailable={platformAvailable}
                initial={{
                  name: profile.name,
                  main: profile.main,
                  worker: profile.worker ?? null,
                  background: profile.background ?? null,
                  vision: profile.vision ?? null,
                }}
                pending={pending}
                onCancel={() => setEditingId(null)}
                onSave={(draft) => onSaveEdit(profile, draft)}
              />
            ) : (
              <ProfileListRow
                key={profile.id}
                profile={profile}
                summary={profileSlotSummary(profile, catalogModels)}
                pending={pending}
                onEdit={() => {
                  setCreating(false);
                  setEditingId(profile.id);
                  setSaveSuccess(null);
                }}
                onSetDefault={() => void onSetDefault(profile)}
                onCopy={() => void onCopy(profile)}
                onDelete={() => onDelete(profile)}
              />
            ),
          )}

          {manageable.length === 0 && !creating && (
            <p className="py-4 text-center text-xs text-muted-foreground">
              暂无组合
            </p>
          )}
        </div>
      )}

      {saveSuccess && (
        <output className="mt-3 block text-xs text-success">
          {saveSuccess}
        </output>
      )}

      {actionError &&
        (typeof actionError === "string" ? (
          <p className="mt-3 text-xs text-destructive">{actionError}</p>
        ) : (
          <div className="mt-3">{actionError}</div>
        ))}
    </section>
  );
}

type ProfileDraft = {
  name: string;
  main: ModelProfileSlot | null;
  worker: ModelProfileSlot | null;
  background: ModelProfileSlot | null;
  vision: ModelProfileSlot | null;
};

function hasAdvancedSlotOverrides(
  draft: Pick<ProfileDraft, "worker" | "background" | "vision">,
): boolean {
  return Boolean(draft.worker || draft.background || draft.vision);
}

/** 高级区收起时的一行摘要。 */
function advancedSlotsSummary(
  worker: ModelProfileSlot | null,
  background: ModelProfileSlot | null,
  vision: ModelProfileSlot | null,
): string {
  if (!worker && !background && !vision) {
    return "组队/后台：跟随主模型 · 识图：不配置";
  }
  const workerLabel = worker?.model ?? "跟随主模型";
  const backgroundLabel = background?.model ?? "跟随主模型";
  const visionLabel = vision?.model ?? "不配置";
  return `组队：${workerLabel} · 后台：${backgroundLabel} · 识图：${visionLabel}`;
}

function ProfileListRow({
  profile,
  summary,
  pending,
  onEdit,
  onSetDefault,
  onCopy,
  onDelete,
}: {
  profile: LlmModelProfileView;
  summary: string;
  pending: boolean;
  onEdit: () => void;
  onSetDefault: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const isUser = profile.kind === "user";
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2",
        profile.is_default ? "border-primary/40 bg-primary/5" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm text-foreground">{profile.name}</p>
            {profile.is_default && (
              <span className="rounded bg-primary/10 px-1 py-0.5 text-xs text-primary">
                默认组合
              </span>
            )}
            {profile.kind === "system" && (
              <span className="rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">
                预置
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {summary}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!profile.is_default && (
            <SimpleTooltip label="设为默认">
              <IconButton
                size="sm"
                aria-label="设为默认"
                disabled={pending}
                onClick={onSetDefault}
              >
                <Star size={14} />
              </IconButton>
            </SimpleTooltip>
          )}
          <SimpleTooltip label="复制">
            <IconButton
              size="sm"
              aria-label="复制"
              disabled={pending}
              onClick={onCopy}
            >
              <Copy size={14} />
            </IconButton>
          </SimpleTooltip>
          {isUser ? (
            <>
              <Button
                variant="neutral"
                size="sm"
                disabled={pending}
                onClick={onEdit}
              >
                编辑
              </Button>
              <SimpleTooltip label="删除">
                <IconButton
                  size="sm"
                  aria-label="删除"
                  disabled={pending}
                  onClick={onDelete}
                >
                  <Trash2 size={14} />
                </IconButton>
              </SimpleTooltip>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 槽位字段：标签与说明并排一行、清除动作靠右，控件紧随其下。
 * 说明放在控件之前，选之前就能读到用途；`id` 同时用于 aria 关联。
 */
function SlotField({
  id,
  label,
  hint,
  clear,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  clear?: { label: string; disabled: boolean; onClear: () => void };
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span
            id={`${id}-label`}
            className="text-xs font-medium text-foreground"
          >
            {label}
          </span>
          {hint ? (
            <span id={`${id}-hint`} className="text-xs text-muted-foreground">
              {hint}
            </span>
          ) : null}
        </span>
        {clear ? (
          <button
            type="button"
            disabled={clear.disabled}
            onClick={clear.onClear}
            className="shrink-0 text-xs text-primary underline-offset-2 hover:underline disabled:opacity-60"
          >
            {clear.label}
          </button>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function ProfileEditor({
  title,
  providers,
  catalog,
  catalogModels,
  platformAvailable,
  initial,
  pending,
  onCancel,
  onSave,
}: {
  title: string;
  providers: LlmProviderView[];
  catalog: ReturnType<typeof useModels>["data"];
  catalogModels: ModelCatalogItem[];
  platformAvailable: boolean;
  initial: ProfileDraft;
  pending: boolean;
  onCancel: () => void;
  onSave: (draft: ProfileDraft) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [main, setMain] = useState(initial.main);
  const [worker, setWorker] = useState(initial.worker);
  const [background, setBackground] = useState(initial.background);
  const [vision, setVision] = useState(initial.vision);
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    hasAdvancedSlotOverrides(initial),
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 只 fold-in 当前编辑组合的槽位，避免跨组合污染建议。
  const groups = useMemo(
    () =>
      buildDefaultProviderGroups(
        providers,
        catalog,
        main,
        worker,
        background,
        vision,
      ),
    [providers, catalog, main, worker, background, vision],
  );
  const visionGroups = useMemo(
    () => buildVisionProviderGroups(providers, catalog, vision),
    [providers, catalog, vision],
  );

  const canChoose = canChooseFromGroups(groups);
  const canChooseVision = canChooseFromGroups(visionGroups);
  const showEmptyGuide = !canChoose;
  const mainVisionCapable = mainHasCuratedVision(main, catalogModels);
  const busy = pending || saving;

  const handleSave = async () => {
    setSaveError(null);
    setSaving(true);
    try {
      await onSave({ name, main, worker, background, vision });
    } catch (e) {
      setSaveError(modelConfigApiErrorMessage(e, "保存失败，请重试"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
      <p className="text-sm font-semibold text-foreground">{title}</p>

      <div className="max-w-md space-y-4">
        <label className="block" htmlFor="profile-name">
          <span className="text-xs font-medium text-foreground">名称</span>
          <input
            id="profile-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            className="mt-1.5 h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
          />
        </label>
        <SlotField id="profile-main" label="主模型" hint="必填">
          <ProfileModelSelect
            id="profile-main"
            labelledBy="profile-main-label"
            describedBy="profile-main-hint"
            groups={groups}
            value={pointerValue(main)}
            disabled={busy}
            onChange={(value) => setMain(decodePointer(value))}
          />
          {showEmptyGuide && (
            <NoAvailableModelsGuide
              className="mt-1.5"
              platformAvailable={platformAvailable}
            />
          )}
        </SlotField>
      </div>

      <div className="border-t border-border pt-3">
        <button
          type="button"
          aria-expanded={advancedOpen}
          disabled={busy}
          onClick={() => setAdvancedOpen((open) => !open)}
          className="flex w-full max-w-md items-center gap-2 py-1 pr-2.5 text-left disabled:opacity-60"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">
              高级 · 其他模型
            </span>
            {!advancedOpen && (
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {advancedSlotsSummary(worker, background, vision)}
              </span>
            )}
          </span>
          <ChevronDown
            size={14}
            className={cn(
              "shrink-0 text-muted-foreground transition-transform",
              !advancedOpen && "-rotate-90",
            )}
          />
        </button>
        {advancedOpen && (
          <div className="mt-3 max-w-md space-y-4">
            <SlotField
              id="profile-worker"
              label="组队队员"
              hint="协作时队员使用；辩论仍用主模型"
              clear={
                worker
                  ? {
                      label: "恢复跟随",
                      disabled: busy,
                      onClear: () => setWorker(null),
                    }
                  : undefined
              }
            >
              <ProfileModelSelect
                id="profile-worker"
                labelledBy="profile-worker-label"
                describedBy="profile-worker-hint"
                groups={groups}
                value={pointerValue(worker)}
                disabled={busy || !canChoose}
                followLabel="跟随主模型"
                onChange={(value) => setWorker(decodePointer(value))}
              />
            </SlotField>
            <SlotField
              id="profile-background"
              label="后台任务"
              hint="标题、记忆等"
              clear={
                background
                  ? {
                      label: "恢复跟随",
                      disabled: busy,
                      onClear: () => setBackground(null),
                    }
                  : undefined
              }
            >
              <ProfileModelSelect
                id="profile-background"
                labelledBy="profile-background-label"
                describedBy="profile-background-hint"
                groups={groups}
                value={pointerValue(background)}
                disabled={busy || !canChoose}
                followLabel="跟随主模型"
                onChange={(value) => setBackground(decodePointer(value))}
              />
            </SlotField>
            <SlotField
              id="profile-vision"
              label="识图模型（可选）"
              hint={
                mainVisionCapable
                  ? "主模型已可看图，本槽供白板等按需深读"
                  : "主模型不能看图时再配；否则走平台识图或不可用"
              }
              clear={
                vision
                  ? {
                      label: "清除",
                      disabled: busy,
                      onClear: () => setVision(null),
                    }
                  : undefined
              }
            >
              <ProfileModelSelect
                id="profile-vision"
                labelledBy="profile-vision-label"
                describedBy="profile-vision-hint"
                groups={visionGroups}
                value={pointerValue(vision)}
                disabled={busy || !canChooseVision}
                followLabel="不配置"
                onChange={(value) => setVision(decodePointer(value))}
              />
            </SlotField>
          </div>
        )}
      </div>

      {saveError ? (
        <p className="text-xs text-destructive" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button variant="neutral" size="md" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          size="md"
          disabled={busy || !main}
          icon={
            busy ? <Loader2 size={14} className="animate-spin" /> : undefined
          }
          onClick={() => void handleSave()}
        >
          保存
        </Button>
      </div>
    </div>
  );
}
