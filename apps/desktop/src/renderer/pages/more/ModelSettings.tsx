import { modelConfigApiErrorMessage } from "@/components/llm/ModelKeyForm";
import { Button, Card, IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useLlmModelProfiles } from "@/hooks/useLlmModelProfiles";
import { useLlmProviders } from "@/hooks/useLlmProviders";
import { useModels } from "@/hooks/useModels";
import {
  type DefaultProviderGroup,
  PLATFORM_POINTER_ID,
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
import { notifySuccess } from "@/lib/toast";
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
import { Copy, Loader2, Plus, Star, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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

/** groups 内所有 group.models 合计为空（有 provider 但 models 空也算）。 */
function hasSelectableModels(groups: DefaultProviderGroup[]): boolean {
  return groups.some((g) => g.models.length > 0);
}

/** 存在 BYOK 服务商分组时，即使目录为空也可手填 model id。 */
function hasByokProviderGroups(groups: DefaultProviderGroup[]): boolean {
  return groups.some((g) => g.providerId !== PLATFORM_POINTER_ID);
}

/** 目录项或 BYOK 自定义均可选。 */
function canChooseModel(groups: DefaultProviderGroup[]): boolean {
  return hasSelectableModels(groups) || hasByokProviderGroups(groups);
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
            ? "选择账号默认组合（主模型 + 可选 Worker / 后台 / 识图）。可用平台额度直接对话，也可接入服务商。"
            : "选择账号默认组合（主模型 + 可选 Worker / 后台 / 识图）。需自行在 jiurelay 免费配额度或接入服务商。"
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
 * 模型组合列表 + 编辑：主必填；Worker / 后台 / 识图常显。
 * Worker / 后台空 = 跟随主模型；识图空 = 不配置（不 follow main）。
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

  const catalogModels = catalog?.models ?? [];
  const manageable = useMemo(
    () =>
      (profileList?.data ?? []).filter(
        (p) => p.kind === "system" || p.kind === "user",
      ),
    [profileList],
  );

  const groups = buildDefaultProviderGroups(
    providers,
    catalog,
    ...manageable.flatMap((p) => [p.main, p.worker, p.background, p.vision]),
  );
  // 识图槽：过滤后若无 vision 模型则回退全目录（仍可 BYOK 手填）。
  const visionGroups = buildVisionProviderGroups(
    providers,
    catalog,
    ...manageable.map((p) => p.vision),
  );

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
    return firstSlotFromGroups(groups);
  };

  const withPending = async (fn: () => Promise<void>) => {
    setPending(true);
    setActionError(null);
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
      notifySuccess(`已将「${profile.name}」设为默认组合`);
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
      notifySuccess(`已删除「${profile.name}」`);
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
      notifySuccess(`已复制为「${created.name}」`);
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
    setCreating(true);
    setEditingId(null);
  };

  const onSaveCreate = (draft: ProfileDraft) =>
    withPending(async () => {
      if (!draft.main) throw new Error("主模型必填");
      const created = await createLlmModelProfile({
        name: draft.name.trim() || "未命名组合",
        main: draft.main,
        worker: draft.worker,
        background: draft.background,
        vision: draft.vision,
        set_as_default: false,
      } satisfies CreateLlmModelProfileInput);
      setCreating(false);
      setEditingId(null);
      notifySuccess(`已创建「${created.name}」`);
    });

  const onSaveEdit = (profile: LlmModelProfileView, draft: ProfileDraft) =>
    withPending(async () => {
      if (profile.kind !== "user") return;
      if (!draft.main) throw new Error("主模型必填");
      const name = draft.name.trim() || profile.name;
      await updateLlmModelProfile(profile.id, {
        name,
        main: draft.main,
        worker: draft.worker,
        background: draft.background,
        vision: draft.vision,
      });
      setEditingId(null);
      notifySuccess(`已保存「${name}」`);
    });

  return (
    <section>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">模型组合</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            主模型必填；Worker /
            后台可留空跟随；识图可留空不配置。改定义后下一回合生效。
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
              groups={groups}
              visionGroups={visionGroups}
              catalogModels={catalogModels}
              platformAvailable={platformAvailable}
              initial={{
                name: "未命名组合",
                main: seedMain(), // 可能为 null：BYOK 空目录时靠手填 model id
                worker: null,
                background: null,
                vision: null,
              }}
              pending={pending}
              onCancel={() => setCreating(false)}
              onSave={(draft) => void onSaveCreate(draft)}
            />
          )}

          {manageable.map((profile) =>
            editingId === profile.id && profile.kind === "user" ? (
              <ProfileEditor
                key={profile.id}
                title={`编辑「${profile.name}」`}
                groups={groups}
                visionGroups={visionGroups}
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
                onSave={(draft) => void onSaveEdit(profile, draft)}
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

function ProfileEditor({
  title,
  groups,
  visionGroups,
  catalogModels,
  platformAvailable,
  initial,
  pending,
  onCancel,
  onSave,
}: {
  title: string;
  groups: DefaultProviderGroup[];
  visionGroups: DefaultProviderGroup[];
  catalogModels: ModelCatalogItem[];
  platformAvailable: boolean;
  initial: ProfileDraft;
  pending: boolean;
  onCancel: () => void;
  onSave: (draft: ProfileDraft) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [main, setMain] = useState(initial.main);
  const [worker, setWorker] = useState(initial.worker);
  const [background, setBackground] = useState(initial.background);
  const [vision, setVision] = useState(initial.vision);
  const canChoose = canChooseModel(groups);
  const canChooseVision = canChooseModel(visionGroups);
  const showEmptyGuide = !canChoose;
  const mainVisionCapable = mainHasCuratedVision(main, catalogModels);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 px-3 py-3">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <label className="block" htmlFor="profile-name">
        <span className="text-xs text-muted-foreground">名称</span>
        <input
          id="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
          className="mt-1 h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
        />
      </label>
      <label className="block" htmlFor="profile-main">
        <span className="text-xs text-muted-foreground">主模型（必填）</span>
        <ProviderModelSelect
          id="profile-main"
          groups={groups}
          value={pointerValue(main)}
          disabled={pending}
          onChange={(value) => setMain(decodePointer(value))}
        />
        {showEmptyGuide && (
          <NoAvailableModelsGuide
            className="mt-1"
            platformAvailable={platformAvailable}
          />
        )}
      </label>
      <label className="block" htmlFor="profile-worker">
        <span className="text-xs text-muted-foreground">Worker 模型</span>
        <ProviderModelSelect
          id="profile-worker"
          groups={groups}
          value={pointerValue(worker)}
          disabled={pending || !canChoose}
          followLabel="跟随主模型"
          onChange={(value) => setWorker(decodePointer(value))}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          组队队员用；辩论用主模型。留空则跟随主模型。
        </p>
      </label>
      <label className="block" htmlFor="profile-background">
        <span className="text-xs text-muted-foreground">后台任务模型</span>
        <ProviderModelSelect
          id="profile-background"
          groups={groups}
          value={pointerValue(background)}
          disabled={pending || !canChoose}
          followLabel="跟随主模型"
          onChange={(value) => setBackground(decodePointer(value))}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          标题、记忆等后台任务；留空则跟随主模型。
        </p>
      </label>
      <label className="block" htmlFor="profile-vision">
        <span className="text-xs text-muted-foreground">识图模型（可选）</span>
        <ProviderModelSelect
          id="profile-vision"
          groups={visionGroups}
          value={pointerValue(vision)}
          disabled={pending || !canChooseVision}
          followLabel="不配置"
          onChange={(value) => setVision(decodePointer(value))}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          主模型目录标有视觉时，贴图走主模型；本槽供无视觉时的眼→文与白板读图。留空=平台
          VISION_* 兜底或无 reader。
        </p>
        {mainVisionCapable && (
          <p className="mt-1 text-xs text-muted-foreground">
            当前主模型目录标有视觉；已知多模态模型贴图直送主模型，否则仍走本槽眼→文。本槽仍可供白板/按需深读。
          </p>
        )}
      </label>

      <div className="flex justify-end gap-2 pt-1">
        <Button
          variant="neutral"
          size="sm"
          disabled={pending}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button
          size="sm"
          disabled={pending || !main}
          icon={
            pending ? <Loader2 size={14} className="animate-spin" /> : undefined
          }
          onClick={() =>
            onSave({
              name,
              main,
              worker,
              background,
              vision,
            })
          }
        >
          保存
        </Button>
      </div>
    </div>
  );
}

function providerIdFromPointer(value: string): string | null {
  const decoded = value ? decodePointer(value) : null;
  if (!decoded) return null;
  if (decoded.origin === "platform" || !decoded.provider_id) {
    return PLATFORM_POINTER_ID;
  }
  return decoded.provider_id;
}

function ProviderModelSelect({
  id,
  groups,
  value,
  disabled,
  followLabel,
  onChange,
}: {
  id?: string;
  groups: DefaultProviderGroup[];
  value: string;
  disabled?: boolean;
  followLabel?: string;
  onChange: (value: string) => void;
}) {
  const hasByok = useMemo(
    () => groups.some((g) => g.providerId !== PLATFORM_POINTER_ID),
    [groups],
  );

  // 仅平台、无 BYOK：纯目录 <select>，不提供手填。
  if (!hasByok) {
    return (
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
      >
        {followLabel !== undefined ? (
          <option value="">{followLabel}</option>
        ) : (
          value === "" && (
            <option value="" disabled>
              选择模型
            </option>
          )
        )}
        {groups.map((group) => (
          <optgroup key={group.providerId} label={group.providerLabel}>
            {group.models.map((m) => (
              <option
                key={m.model}
                value={encodePointer(group.providerId, m.model)}
              >
                {m.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    );
  }

  return (
    <ByokProviderModelCombobox
      id={id}
      groups={groups}
      value={value}
      disabled={disabled}
      followLabel={followLabel}
      onChange={onChange}
    />
  );
}

/** 有 BYOK 时：服务商下拉 + model id 手填（目录进 datalist 建议）。 */
function ByokProviderModelCombobox({
  id,
  groups,
  value,
  disabled,
  followLabel,
  onChange,
}: {
  id?: string;
  groups: DefaultProviderGroup[];
  value: string;
  disabled?: boolean;
  followLabel?: string;
  onChange: (value: string) => void;
}) {
  const decoded = value ? decodePointer(value) : null;
  const [providerId, setProviderId] = useState(
    () => providerIdFromPointer(value) || groups[0]?.providerId || "",
  );
  const [model, setModel] = useState(() => decoded?.model ?? "");

  useEffect(() => {
    if (!value) {
      setModel("");
      return;
    }
    const d = decodePointer(value);
    if (!d) return;
    const pid = providerIdFromPointer(value);
    if (pid) setProviderId(pid);
    // 已有本地输入时勿用 decode 回写，避免 trim 后吞掉正在输入的空格。
    setModel((prev) => (prev.trim() === d.model ? prev : d.model));
  }, [value]);

  const selectedGroup = groups.find((g) => g.providerId === providerId);
  const listId = id ? `${id}-suggestions` : undefined;

  const emit = (pid: string, nextModel: string) => {
    const trimmed = nextModel.trim();
    if (pid && trimmed) {
      onChange(encodePointer(pid, trimmed));
    } else {
      onChange("");
    }
  };

  const clearFollow = () => {
    setModel("");
    onChange("");
  };

  return (
    <div>
      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
        <select
          id={id ? `${id}-provider` : undefined}
          value={providerId}
          disabled={disabled}
          aria-label="服务商"
          onChange={(e) => {
            const pid = e.target.value;
            setProviderId(pid);
            emit(pid, model);
          }}
          className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60 sm:max-w-[40%]"
        >
          {groups.map((g) => (
            <option key={g.providerId} value={g.providerId}>
              {g.providerLabel}
            </option>
          ))}
        </select>
        <input
          id={id}
          list={listId}
          value={model}
          disabled={disabled}
          aria-label="model id"
          placeholder="model id，如 ep-xxxx"
          onChange={(e) => {
            const next = e.target.value;
            setModel(next);
            emit(providerId, next);
          }}
          className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
        />
        {listId ? (
          <datalist id={listId}>
            {(selectedGroup?.models ?? []).map((m) => (
              <option key={m.model} value={m.model}>
                {m.label}
              </option>
            ))}
          </datalist>
        ) : null}
      </div>
      {followLabel !== undefined ? (
        value ? (
          <button
            type="button"
            disabled={disabled}
            className="mt-1 text-xs text-primary underline-offset-2 hover:underline disabled:opacity-60"
            onClick={clearFollow}
          >
            {followLabel}
          </button>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">{followLabel}</p>
        )
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">
        可从建议中选择，或直接粘贴 / 手填 model id（火山 ep-、中转私有 id 等）。
      </p>
    </div>
  );
}
