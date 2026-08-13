import {
  SettingField,
  SettingsAsync,
  SettingsFormMessage,
  SettingsSection,
  SettingsStack,
} from "@/components/settings";
import { Button, Card, ConfirmDialog, Input } from "@/components/ui";
import { errMsg } from "@/lib/errMsg";
import { gitCredentialKeys } from "@/lib/queryKeys";
import {
  deleteGitCredentials,
  getGitCredentials,
  upsertGitCredentials,
} from "@/services/gitCredentials";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { SettingsHeader } from "./SettingsHeader";

/**
 * Git 凭据 (/more/git) — G3 远程产品化。
 *
 * 云工作区：账户级 PAT（加密落库）供 clone/push。
 * 本地工作区：继承 OS credential helper / `gh auth`，本页只做诚实说明。
 */
export function GitCredentialSettings() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: gitCredentialKeys.detail,
    queryFn: getGitCredentials,
  });

  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const saveMutation = useMutation({
    mutationFn: () =>
      upsertGitCredentials({
        token: token.trim(),
        username: username.trim() || null,
      }),
    onSuccess: () => {
      setToken("");
      setFormError(null);
      void queryClient.invalidateQueries({
        queryKey: gitCredentialKeys.detail,
      });
    },
    onError: (e) => setFormError(errMsg(e, "保存失败，请重试")),
  });

  const clearMutation = useMutation({
    mutationFn: deleteGitCredentials,
    onSuccess: () => {
      setFormError(null);
      void queryClient.invalidateQueries({
        queryKey: gitCredentialKeys.detail,
      });
    },
    onError: (e) => setFormError(errMsg(e, "清除失败，请重试")),
    // A failure belongs on the page next to the form, not stranded in the modal.
    onSettled: () => setConfirmClear(false),
  });

  const configured = data?.configured === true;
  const busy = saveMutation.isPending || clearMutation.isPending;

  return (
    <div>
      <SettingsHeader
        title="Git 凭据"
        description="云工作区私仓用账户级 PAT；本地仓继承本机凭据。工具永不收密码参数。"
      />
      <SettingsStack>
        <SettingsSection
          title="云工作区 · PAT"
          description={
            <>
              用于云端浅克隆与 push/fetch/pull 私有 http(s)
              仓。明文加密落库，响应仅掩码。 公网仓可不配。生成 GitHub PAT
              时勾选
              <code className="mx-1 rounded bg-muted px-1">repo</code>
              权限即可。
            </>
          }
        >
          <Card className="space-y-4 p-4">
            <SettingsAsync
              loading={isLoading}
              error={isError ? errMsg(error, "无法加载凭据状态") : undefined}
            >
              <p className="text-sm text-muted-foreground">
                {configured
                  ? `已配置${data?.username ? `（用户 ${data.username}）` : ""} · 掩码 ${data?.masked_token ?? "••••"}`
                  : "尚未配置。公网仓可直接克隆；私仓请先保存 PAT。"}
              </p>
            </SettingsAsync>

            <SettingField label="Personal Access Token" htmlFor="git-pat">
              <Input
                id="git-pat"
                type="password"
                autoComplete="off"
                placeholder={
                  configured
                    ? "输入新 PAT 以替换"
                    : "ghp_… 或 fine-grained token"
                }
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={busy}
              />
            </SettingField>
            <SettingField label="用户名（可选）" htmlFor="git-username">
              <Input
                id="git-username"
                autoComplete="off"
                placeholder="默认 x-access-token（GitHub PAT）"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={busy}
              />
            </SettingField>

            <SettingsFormMessage>{formError}</SettingsFormMessage>

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || !token.trim()}
                icon={
                  saveMutation.isPending ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : undefined
                }
                onClick={() => saveMutation.mutate()}
              >
                {configured ? "更新凭据" : "保存凭据"}
              </Button>
              {configured && (
                <Button
                  variant="neutral"
                  disabled={busy}
                  onClick={() => setConfirmClear(true)}
                >
                  清除
                </Button>
              )}
            </div>
          </Card>
        </SettingsSection>

        <SettingsSection
          title="本地工作区"
          description={
            <>
              AgentCore 不代持本机密码。本地仓的 clone / push 继承操作系统 Git
              credential helper，或你已用
              <code className="mx-1 rounded bg-muted px-1">gh auth login</code>
              配置的 GitHub CLI 凭据。请在本机终端先确认
              <code className="mx-1 rounded bg-muted px-1">git push</code>
              可用，再在产品里打开该本地仓。
            </>
          }
        >
          <Card className="p-4 text-sm text-muted-foreground">
            云端文件页可对云工作区「克隆仓库」；本地请用已认证的本机仓库目录绑定工作区。
            需要私仓云克隆时回到本页配置 PAT。也可从{" "}
            <Link
              to="/files"
              className="text-foreground underline underline-offset-2"
            >
              文件
            </Link>{" "}
            页对云工作区右键克隆。
          </Card>
        </SettingsSection>
      </SettingsStack>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="清除账户 Git 凭据？"
        description="云私仓的 clone / push 将失败，直至重新配置 PAT。"
        confirmLabel="清除"
        tone="danger"
        busy={clearMutation.isPending}
        onConfirm={() => clearMutation.mutate()}
      />
    </div>
  );
}
