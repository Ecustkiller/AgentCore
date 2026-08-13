import { listLlmProviders } from "@/api/llmProviders";
import {
  type LlmModelProfileListResponse,
  type LlmModelProfileView,
  defaultProfile,
  profileSlotsSummary,
  useModelProfiles,
} from "@/api/modelProfiles";
import { useModels } from "@/api/models";
import { Modal } from "@/components/Modal";
import { MODEL_CONFIG_PATH } from "@/lib/errors";
// 会话级模型组合选择 (touch-native bottom sheet) · 定案 B「新建拍快照」.
//
// Lists account combinations; selection is a concrete profile id only（无「跟随账号默认」）.
// 「管理组合」routes to 设置·模型配置. No bare model list.
import { Check, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export function ModelPicker({
  conversationProfileId,
  onSelect,
  onClose,
}: {
  /** Conversation snapshotted profile id (null = draft / not yet chosen). */
  conversationProfileId: string | null;
  /** Concrete profile id to apply (create snapshot or PATCH). */
  onSelect: (profileId: string) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data, loading, error } = useModelProfiles({ force: true });
  const { data: catalog } = useModels();
  const [platformAvailable, setPlatformAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listLlmProviders()
      .then((res) => {
        if (!cancelled) setPlatformAvailable(res.platform_available === true);
      })
      .catch(() => {
        if (!cancelled) setPlatformAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const accountDefault = defaultProfile(data);
  const effectiveId = conversationProfileId ?? accountDefault?.id ?? null;

  function openManage() {
    onClose();
    navigate(MODEL_CONFIG_PATH);
  }

  return (
    <Modal className="sheet model-sheet" onClose={onClose} label="选择模型组合">
      <div className="sheet-title">选择模型组合</div>

      <div className="model-list">
        {loading && !data && <p className="muted hint">加载中…</p>}
        {error && !data && <p className="error hint">{error}</p>}

        {data && (
          <>
            <ProfileRows
              list={data}
              effectiveId={effectiveId}
              catalog={catalog}
              platformAvailable={platformAvailable}
              onSelect={onSelect}
              onOpenManage={openManage}
            />

            <button
              type="button"
              className="model-row"
              data-testid="profile-manage"
              onClick={openManage}
            >
              <div className="model-row-main">
                <span className="model-name">管理组合</span>
                <span className="model-sub muted">
                  新建、编辑或设置账号默认 · 设置·模型配置
                </span>
              </div>
              <ChevronRight size={16} className="muted" aria-hidden />
            </button>
          </>
        )}
      </div>

      <button
        type="button"
        className="sheet-item sheet-cancel"
        onClick={onClose}
      >
        取消
      </button>
    </Modal>
  );
}

function ProfileRows({
  list,
  effectiveId,
  catalog,
  platformAvailable,
  onSelect,
  onOpenManage,
}: {
  list: LlmModelProfileListResponse;
  effectiveId: string | null;
  catalog: ReturnType<typeof useModels>["data"];
  platformAvailable: boolean;
  onSelect: (profileId: string) => void;
  onOpenManage: () => void;
}) {
  // Hide migration-only implicit profiles from the picker unless currently selected.
  const rows = list.data.filter(
    (p) => p.kind !== "implicit" || p.id === effectiveId,
  );

  if (rows.length === 0) {
    return (
      <div className="muted hint" data-testid="profiles-empty">
        <p>暂无可用组合</p>
        {platformAvailable ? (
          <p data-testid="profiles-empty-platform">
            请稍后重试，或到设置检查模型配置。{" "}
            <button type="button" className="link" onClick={onOpenManage}>
              去模型配置
            </button>
          </p>
        ) : (
          <p data-testid="profiles-empty-byok">
            请先到{" "}
            <a href="https://jiurelay.com/" target="_blank" rel="noreferrer">
              jiurelay
            </a>{" "}
            免费自配额度，或{" "}
            <button type="button" className="link" onClick={onOpenManage}>
              去模型配置
            </button>
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      {rows.map((profile) => (
        <ProfileRow
          key={profile.id}
          profile={profile}
          selected={profile.id === effectiveId}
          summary={profileSlotsSummary(catalog, profile)}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function ProfileRow({
  profile,
  selected,
  summary,
  onSelect,
}: {
  profile: LlmModelProfileView;
  selected: boolean;
  summary: string;
  onSelect: (profileId: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`profile-row-${profile.id}`}
      className={`model-row${selected ? " model-row-selected" : ""}`}
      onClick={() => onSelect(profile.id)}
    >
      <div className="model-row-main">
        <span className="model-name-row">
          <span className="model-name">{profile.name}</span>
          {profile.is_default && <span className="model-free-tier">默认</span>}
          {profile.kind === "system" && (
            <span className="model-preset-badge">预置</span>
          )}
        </span>
        <span className="model-sub muted">{summary}</span>
      </div>
      {selected ? (
        <Check size={18} className="model-check" aria-hidden />
      ) : null}
    </button>
  );
}
