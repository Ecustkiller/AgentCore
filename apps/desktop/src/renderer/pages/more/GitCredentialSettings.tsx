import { Button, Card, Input } from "@/components/ui";
import { gitCredentialKeys } from "@/lib/queryKeys";
import { ApiError } from "@/services/api";
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

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? (e.serverMessage ?? fallback) : fallback;
}

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
  });

  const configured = data?.configured === true;
  const busy = saveMutation.isPending || clearMutation.isPending;

  return (
    <div>
      <SettingsHeader
        title="Git 凭据"
        description="云工作区私仓用账户级 PAT；本地仓继承本机凭据。工具永不收密码参数。"
      />
      <div className="mt-6 space-y-8">
        <section>
          <h2 className="text-sm font-semibold text-foreground">
            云工作区 · PAT
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            用于云端浅克隆与 push/fetch/pull 私有 http(s)
            仓。明文加密落库，响应仅掩码。 公网仓可不配。生成 GitHub PAT 时勾选
            <code className="mx-1 rounded bg-muted px-1">repo</code>
            权限即可。
          </p>
          <Card className="mt-3 space-y-4 p-4">
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                加载中…
              </div>
            ) : isError ? (
              <p className="text-sm text-destructive">
                {errMsg(error, "无法加载凭据状态")}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {configured
                  ? `已配置${data?.username ? `（用户 ${data.username}）` : ""} · 掩码 ${data?.masked_token ?? "••••"}`
                  : "尚未配置。公网仓可直接克隆；私仓请先保存 PAT。"}
              </p>
            )}

            <div className="space-y-2">
              <label
                className="text-xs font-medium text-foreground"
                htmlFor="git-pat"
              >
                Personal Access Token
              </label>
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
            </div>
            <div className="space-y-2">
              <label
                className="text-xs font-medium text-foreground"
                htmlFor="git-username"
              >
                用户名（可选）
              </label>
              <Input
                id="git-username"
                autoComplete="off"
                placeholder="默认 x-access-token（GitHub PAT）"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={busy}
              />
            </div>

            {formError && (
              <p className="text-sm text-destructive" role="alert">
                {formError}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || !token.trim()}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {configured ? "更新凭据" : "保存凭据"}
              </Button>
              {configured && (
                <Button
                  variant="neutral"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "清除账户 Git 凭据？云私仓 clone/push 将失败直至重新配置。",
                      )
                    )
                      return;
                    clearMutation.mutate();
                  }}
                >
                  清除
                </Button>
              )}
            </div>
          </Card>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-foreground">本地工作区</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            AgentCore 不代持本机密码。本地仓的 clone / push 继承操作系统 Git
            credential helper，或你已用
            <code className="mx-1 rounded bg-muted px-1">gh auth login</code>
            配置的 GitHub CLI 凭据。请在本机终端先确认
            <code className="mx-1 rounded bg-muted px-1">git push</code>
            可用，再在产品里打开该本地仓。
          </p>
          <Card className="mt-3 p-4 text-sm text-muted-foreground">
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
        </section>
      </div>
    </div>
  );
}
