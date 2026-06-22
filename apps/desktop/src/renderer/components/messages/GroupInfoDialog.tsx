import { Button, IconButton } from "@/components/ui";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { messagingErrorMessage } from "@/services/messaging";
import { useAuthStore } from "@/stores/auth";
import { useChatMembers, useMessagingStore } from "@/stores/messaging";
import {
  AlertTriangle,
  LogOut,
  Megaphone,
  Mic,
  MicOff,
  UserX,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { avatarInitial, chatDisplayName } from "./chatDisplay";

interface Props {
  chatId: string;
  open: boolean;
  onClose: () => void;
}

/** A pill switch for a per-chat flag (mute / pin). */
function Toggle({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <Button
      variant="ghost"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className="h-auto w-full justify-between px-1 py-2 text-sm hover:bg-accent/50"
    >
      <span className="text-foreground">{label}</span>
      <span
        className={`flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${
          on ? "bg-primary" : "bg-muted"
        }`}
      >
        <span
          className={`size-4 rounded-full bg-background transition-transform ${
            on ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </Button>
  );
}

/**
 * 群信息面板: the active group's roster + this user's per-chat controls (mute,
 * pin, leave). Leaving the 内测群 sticks — auto-join only fires at registration —
 * so the leave action confirms inline before removing membership.
 *
 * For a platform admin (创始团队 = the 内测群's moderators, Stage 3 审核治理) it
 * also exposes moderation: post an announcement (a centered system_card), and
 * per-member 禁言/解禁 + 移出. Admins can't be moderated (the controls are hidden
 * on admin rows and on self; the server enforces it too), and 移出 confirms inline
 * since a kicked user can't rejoin (auto-join is registration-only).
 */
export function GroupInfoDialog({ chatId, open, onClose }: Props) {
  const chat = useMessagingStore(
    (s) => s.chats.find((c) => c.id === chatId) ?? null,
  );
  const members = useChatMembers(chatId);
  const loadMembers = useMessagingStore((s) => s.loadMembers);
  const setMembershipFlags = useMessagingStore((s) => s.setMembershipFlags);
  const leaveChat = useMessagingStore((s) => s.leaveChat);
  const kickMember = useMessagingStore((s) => s.kickMember);
  const setAdminMute = useMessagingStore((s) => s.setAdminMute);
  const announce = useMessagingStore((s) => s.announce);
  const myId = useAuthStore((s) => s.user?.id ?? null);
  const viewerIsAdmin = useAuthStore((s) => s.user?.role === "admin");
  const navigate = useNavigate();
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [confirmKickId, setConfirmKickId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [posting, setPosting] = useState(false);
  const [modError, setModError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setConfirmingLeave(false);
      setConfirmKickId(null);
      setAnnouncement("");
      setModError(null);
      void loadMembers(chatId);
    }
  }, [open, chatId, loadMembers]);

  if (!chat) return null;
  const name = chatDisplayName(chat);

  const handleLeave = async () => {
    setLeaving(true);
    const ok = await leaveChat(chatId);
    setLeaving(false);
    if (ok) {
      onClose();
      navigate("/messages");
    }
  };

  const handleMute = async (userId: string, muted: boolean) => {
    setBusyId(userId);
    setModError(null);
    try {
      await setAdminMute(chatId, userId, muted);
    } catch (err) {
      setModError(messagingErrorMessage(err, "操作失败，请重试"));
    } finally {
      setBusyId(null);
    }
  };

  const handleKick = async (userId: string) => {
    setBusyId(userId);
    setModError(null);
    try {
      await kickMember(chatId, userId);
      setConfirmKickId(null);
    } catch (err) {
      setModError(messagingErrorMessage(err, "操作失败，请重试"));
    } finally {
      setBusyId(null);
    }
  };

  const handleAnnounce = async () => {
    const text = announcement.trim();
    if (!text) return;
    setPosting(true);
    setModError(null);
    try {
      await announce(chatId, text);
      setAnnouncement("");
    } catch (err) {
      setModError(messagingErrorMessage(err, "发布失败，请重试"));
    } finally {
      setPosting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm" aria-describedby={undefined}>
        <div className="flex flex-col items-center gap-2 border-b border-border px-5 py-5">
          <span className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-xl font-medium text-primary">
            {avatarInitial(name)}
          </span>
          <DialogTitle className="text-center">{name}</DialogTitle>
          <span className="text-xs text-muted-foreground">
            {members.length} 名成员
          </span>
        </div>

        {modError && (
          <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertTriangle size={15} className="shrink-0" />
            <span className="min-w-0 flex-1">{modError}</span>
            <IconButton
              onClick={() => setModError(null)}
              aria-label="关闭"
              className="text-destructive/70 hover:bg-transparent hover:text-destructive"
            >
              <X size={14} />
            </IconButton>
          </div>
        )}

        <div className="px-4 py-2">
          <Toggle
            label="消息免打扰"
            on={chat.muted}
            onToggle={() =>
              void setMembershipFlags(chatId, { muted: !chat.muted })
            }
          />
          <Toggle
            label="置顶会话"
            on={chat.pinned}
            onToggle={() =>
              void setMembershipFlags(chatId, { pinned: !chat.pinned })
            }
          />
        </div>

        {viewerIsAdmin && (
          <div className="border-t border-border px-4 py-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Megaphone size={14} /> 发布公告
            </p>
            <textarea
              value={announcement}
              onChange={(e) => setAnnouncement(e.target.value)}
              placeholder="向全体成员发布一条公告…"
              rows={2}
              className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="mt-2 flex justify-end">
              <Button
                disabled={!announcement.trim() || posting}
                onClick={() => void handleAnnounce()}
              >
                {posting ? "发布中…" : "发布"}
              </Button>
            </div>
          </div>
        )}

        <div className="min-h-0 border-t border-border">
          <p className="px-5 pb-1 pt-3 text-xs font-medium text-muted-foreground">
            成员
          </p>
          <ul className="max-h-60 overflow-y-auto px-2 pb-2">
            {members.map((m) => {
              const canModerate = viewerIsAdmin && !m.is_admin && m.id !== myId;
              return (
                <li
                  key={m.id}
                  className="group flex items-center gap-3 rounded-lg px-3 py-1.5 hover:bg-accent/50"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
                    {avatarInitial(m.display_name || m.username)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm text-foreground">
                        {m.display_name || m.username}
                      </span>
                      {m.is_admin && (
                        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                          管理员
                        </span>
                      )}
                      {m.muted_by_admin && viewerIsAdmin && (
                        <span className="shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
                          已禁言
                        </span>
                      )}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      @{m.username}
                    </span>
                  </span>

                  {canModerate &&
                    (confirmKickId === m.id ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="neutral"
                          onClick={() => setConfirmKickId(null)}
                        >
                          取消
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={busyId === m.id}
                          onClick={() => void handleKick(m.id)}
                        >
                          移出
                        </Button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <IconButton
                          disabled={busyId === m.id}
                          onClick={() =>
                            void handleMute(m.id, !m.muted_by_admin)
                          }
                          aria-label={m.muted_by_admin ? "解除禁言" : "禁言"}
                          title={m.muted_by_admin ? "解除禁言" : "禁言"}
                        >
                          {m.muted_by_admin ? (
                            <Mic size={14} />
                          ) : (
                            <MicOff size={14} />
                          )}
                        </IconButton>
                        <IconButton
                          disabled={busyId === m.id}
                          onClick={() => setConfirmKickId(m.id)}
                          aria-label="移出群聊"
                          title="移出群聊"
                          className="hover:bg-destructive/10 hover:text-destructive"
                        >
                          <UserX size={14} />
                        </IconButton>
                      </div>
                    ))}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="border-t border-border px-5 py-4">
          {confirmingLeave ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">
                退出后需重新邀请才能再加入
              </span>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="neutral"
                  onClick={() => setConfirmingLeave(false)}
                >
                  取消
                </Button>
                <Button
                  variant="destructive"
                  className="disabled:opacity-50"
                  disabled={leaving}
                  onClick={() => void handleLeave()}
                >
                  {leaving ? "退出中…" : "确认退出"}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="danger"
              className="h-auto w-full py-2 text-sm"
              icon={<LogOut size={16} />}
              onClick={() => setConfirmingLeave(true)}
            >
              退出群聊
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
