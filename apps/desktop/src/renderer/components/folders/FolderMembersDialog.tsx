import { EmptyHint, InlineError } from "@/components/files/parts";
import { avatarInitial } from "@/components/messages/chatDisplay";
import {
  Badge,
  Button,
  ConfirmDialog,
  IconButton,
  SearchField,
} from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useChangeFolderMemberRole,
  useFolderMembers,
  useInviteFolderMember,
  useRemoveOrLeaveFolderMember,
} from "@/hooks/useFolderSharing";
import { notifyError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  type FolderInviteRole,
  type FolderMemberRole,
  type FolderMemberState,
  type FolderMemberSummary,
  folderRoleLabel,
} from "@/services/folders";
import {
  type UserSearchResult,
  messagingErrorMessage,
  searchUsers,
} from "@/services/messaging";
import { useAuthStore } from "@/stores/auth";
import { useMessagingStore } from "@/stores/messaging";
import {
  Check,
  ChevronDown,
  Loader2,
  MoreHorizontal,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const SUGGEST_FRIEND_CAP = 5;

const INVITE_ROLES: { value: FolderInviteRole; label: string }[] = [
  { value: "editor", label: "可编辑" },
  { value: "viewer", label: "只读" },
];

type Invitee = {
  id: string;
  display_name: string;
  username: string;
};

type ConfirmKind = "cancel-invite" | "remove" | "leave";

type ConfirmTarget = {
  kind: ConfirmKind;
  userId: string;
  label: string;
};

function roleTone(role: FolderMemberRole): "primary" | "success" | "muted" {
  if (role === "owner") return "primary";
  if (role === "editor") return "success";
  return "muted";
}

function personLabel(person: {
  display_name?: string | null;
  username?: string | null;
  id?: string;
  user_id?: string;
}): string {
  return (
    person.display_name ||
    person.username ||
    (person.id ?? person.user_id ?? "").slice(0, 8)
  );
}

function toInvitee(person: {
  id: string;
  display_name: string;
  username: string;
}): Invitee {
  return {
    id: person.id,
    display_name: person.display_name,
    username: person.username,
  };
}

function matchesQuery(person: Invitee, needle: string): boolean {
  if (!needle) return true;
  return (
    person.display_name.toLowerCase().includes(needle) ||
    person.username.toLowerCase().includes(needle)
  );
}

function confirmCopy(
  target: ConfirmTarget,
  folderName: string,
): { title: string; confirmLabel: string } {
  if (target.kind === "cancel-invite") {
    return {
      title: `取消对「${target.label}」的邀请？`,
      confirmLabel: "取消邀请",
    };
  }
  if (target.kind === "remove") {
    return {
      title: `确定移除成员「${target.label}」？`,
      confirmLabel: "移除",
    };
  }
  return {
    title: `确定退出「${folderName}」？`,
    confirmLabel: "退出",
  };
}

/**
 * Owner: search-combobox invite (friend suggestions + exact username / ID)
 * as chips, then one footer send. Roster is the body (role menu + overflow).
 * Member: view roster + leave self. Cloud folders only.
 */
export function FolderMembersDialog({
  open,
  onClose,
  folderId,
  folderName,
  myRole,
}: {
  open: boolean;
  onClose: () => void;
  folderId: string;
  folderName: string;
  myRole: FolderMemberRole;
}) {
  const meId = useAuthStore((s) => s.user?.id ?? null);
  const isOwner = myRole === "owner";
  const { data, isLoading, isError, refetch } = useFolderMembers(
    open ? folderId : null,
  );
  const members = data ?? [];
  const invite = useInviteFolderMember();
  const changeRole = useChangeFolderMemberRole();
  const removeOrLeave = useRemoveOrLeaveFolderMember();

  const friends = useMessagingStore((s) => s.friends);
  const friendsLoaded = useMessagingStore((s) => s.friendsLoaded);
  const fetchFriends = useMessagingStore((s) => s.fetchFriends);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<FolderInviteRole>("editor");
  const [invitees, setInvitees] = useState<Invitee[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [batchInviting, setBatchInviting] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);

  const memberStateByUserId = useMemo(() => {
    const map = new Map<string, FolderMemberState>();
    for (const m of members) map.set(m.user_id, m.state);
    return map;
  }, [members]);

  const selectedIds = useMemo(
    () => new Set(invitees.map((p) => p.id)),
    [invitees],
  );
  const friendIdSet = useMemo(
    () => new Set(friends.map((f) => f.id)),
    [friends],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setSearchError(null);
    setInviteRole("editor");
    setInvitees([]);
    setSuggesting(false);
    setBatchInviting(false);
    setConfirm(null);
  }, [open]);

  useEffect(() => {
    if (!open || !isOwner) return;
    void fetchFriends();
  }, [open, isOwner, fetchFriends]);

  useEffect(() => {
    setInvitees((prev) => {
      const next = prev.filter((p) => !memberStateByUserId.has(p.id));
      return next.length === prev.length ? prev : next;
    });
  }, [memberStateByUserId]);

  useEffect(() => {
    if (!open || !isOwner) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const users = await searchUsers(q);
          if (!cancelled) {
            setResults(users);
            setSearchError(null);
          }
        } catch (err) {
          if (!cancelled) {
            setResults([]);
            setSearchError(messagingErrorMessage(err, "搜索失败，请重试"));
          }
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, open, isOwner]);

  const canInviteId = (id: string) =>
    !memberStateByUserId.has(id) && !selectedIds.has(id);

  const needle = query.trim().toLowerCase();
  const friendSuggestions = friends.filter((f) => {
    if (!canInviteId(f.id)) return false;
    return matchesQuery(toInvitee(f), needle);
  });
  const shownFriends = needle
    ? friendSuggestions
    : friendSuggestions.slice(0, SUGGEST_FRIEND_CAP);
  const searchSuggestions = results.filter(
    (u) => canInviteId(u.id) && !friendIdSet.has(u.id),
  );
  const suggestions: Invitee[] = [
    ...shownFriends.map(toInvitee),
    ...searchSuggestions.map(toInvitee),
  ];

  const addInvitee = (person: Invitee) => {
    if (!canInviteId(person.id)) return;
    setInvitees((prev) => [...prev, person]);
    setQuery("");
    setResults([]);
    setSearchError(null);
  };

  const removeInvitee = (id: string) => {
    setInvitees((prev) => prev.filter((p) => p.id !== id));
  };

  const handleInviteSelected = async () => {
    const ids = invitees
      .map((p) => p.id)
      .filter((id) => !memberStateByUserId.has(id));
    if (ids.length === 0) return;
    setBatchInviting(true);
    let failed = 0;
    for (const userId of ids) {
      try {
        await invite.mutateAsync({ folderId, userId, role: inviteRole });
      } catch {
        failed += 1;
      }
    }
    setBatchInviting(false);
    setInvitees([]);
    if (failed > 0) notifyError(`有 ${failed} 人邀请失败`);
  };

  const inviteBusy = invite.isPending || batchInviting;
  const selectedCount = invitees.length;
  const showSuggestPanel = isOwner && suggesting;

  const runConfirm = () => {
    if (!confirm) return;
    const target = confirm;
    setConfirm(null);
    removeOrLeave.mutate(
      { folderId, memberUserId: target.userId },
      {
        onSuccess: () => {
          if (target.kind === "leave") onClose();
        },
        onError: (err) =>
          notifyError(
            err,
            target.kind === "cancel-invite"
              ? "取消邀请失败"
              : target.kind === "leave"
                ? "退出失败"
                : "移除成员失败",
          ),
      },
    );
  };

  const confirmLabels = confirm ? confirmCopy(confirm, folderName) : null;

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent size="md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>成员 · {folderName}</DialogTitle>
          </DialogHeader>

          {isOwner && (
            <div className="border-b border-border px-5 pb-3">
              <div className="flex items-start gap-1.5">
                <div className="min-w-0 flex-1">
                  <div className="rounded-lg border border-border px-2 py-1.5">
                    {invitees.length > 0 && (
                      <ul className="mb-1 flex flex-wrap gap-1">
                        {invitees.map((p) => {
                          const label = personLabel(p);
                          return (
                            <li key={p.id}>
                              <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                                <span className="truncate">{label}</span>
                                <button
                                  type="button"
                                  aria-label={`取消选择 ${label}`}
                                  disabled={inviteBusy}
                                  onClick={() => removeInvitee(p.id)}
                                  className="rounded-full text-muted-foreground hover:text-foreground"
                                >
                                  <X size={10} />
                                </button>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <SearchField
                      variant="plain"
                      value={query}
                      onValueChange={(value) => {
                        setQuery(value);
                        if (value.trim()) setSuggesting(true);
                      }}
                      placeholder="搜索好友、用户名或 ID"
                      aria-label="搜索好友、用户名或 ID"
                      onFocus={() => setSuggesting(true)}
                      onBlur={() => setSuggesting(false)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          if (query) {
                            e.preventDefault();
                            setQuery("");
                          } else {
                            setSuggesting(false);
                          }
                          return;
                        }
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        if (query.trim() && suggestions[0]) {
                          addInvitee(suggestions[0]);
                          return;
                        }
                        if (!query.trim() && selectedCount > 0 && !inviteBusy) {
                          void handleInviteSelected();
                        }
                      }}
                    />
                  </div>
                  {showSuggestPanel && (
                    <ul
                      onMouseDown={(e) => e.preventDefault()}
                      className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover py-1"
                    >
                      {!friendsLoaded && friends.length === 0 && !needle ? (
                        <li className="px-3 py-2 text-xs text-muted-foreground">
                          加载中…
                        </li>
                      ) : suggestions.length > 0 ? (
                        suggestions.map((u) => {
                          const label = personLabel(u);
                          return (
                            <li key={u.id}>
                              <Button
                                variant="ghost"
                                disabled={inviteBusy}
                                onClick={() => addInvitee(u)}
                                className="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 font-normal"
                              >
                                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                                  {avatarInitial(label)}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-left text-sm">
                                  {label}
                                  <span className="ml-1 text-xs text-muted-foreground">
                                    @{u.username}
                                  </span>
                                </span>
                              </Button>
                            </li>
                          );
                        })
                      ) : searchError ? (
                        <li className="px-3 py-2 text-xs text-muted-foreground">
                          {searchError}
                        </li>
                      ) : searching ? (
                        <li className="px-3 py-2 text-xs text-muted-foreground">
                          查找中…
                        </li>
                      ) : needle ? (
                        <li className="px-3 py-2 text-xs text-muted-foreground">
                          未找到用户（需精确用户名或 ID）
                        </li>
                      ) : (
                        <li className="px-3 py-2 text-xs text-muted-foreground">
                          {friends.length === 0
                            ? "输入用户名或 ID"
                            : "输入用户名或 ID 查找其他人"}
                        </li>
                      )}
                    </ul>
                  )}
                </div>
                <InviteRoleMenu
                  value={inviteRole}
                  disabled={inviteBusy}
                  onChange={setInviteRole}
                />
              </div>
            </div>
          )}

          <DialogBody
            className={cn(
              "max-h-[50vh] min-h-[8rem]",
              selectedCount > 0 ? "pb-1" : "pb-5",
            )}
          >
            {isLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2
                  size={18}
                  className="animate-spin text-muted-foreground/50"
                />
              </div>
            ) : isError ? (
              <InlineError onRetry={() => void refetch()} />
            ) : members.length === 0 ? (
              <EmptyHint
                inline
                icon={<Users size={22} className="text-muted-foreground/40" />}
                title="暂无成员"
              />
            ) : (
              <ul className="divide-y divide-border">
                {members.map((m) => (
                  <MemberRow
                    key={m.user_id}
                    member={m}
                    isSelf={m.user_id === meId}
                    isOwner={isOwner}
                    busy={
                      (changeRole.isPending &&
                        changeRole.variables?.memberUserId === m.user_id) ||
                      (removeOrLeave.isPending &&
                        removeOrLeave.variables?.memberUserId === m.user_id)
                    }
                    onChangeRole={(role) =>
                      changeRole.mutate(
                        {
                          folderId,
                          memberUserId: m.user_id,
                          role,
                        },
                        {
                          onError: (err) => notifyError(err, "更改角色失败"),
                        },
                      )
                    }
                    onAskConfirm={setConfirm}
                  />
                ))}
              </ul>
            )}
          </DialogBody>

          {isOwner && selectedCount > 0 && (
            <DialogFooter>
              <Button
                variant="primary"
                disabled={inviteBusy}
                onClick={() => void handleInviteSelected()}
              >
                {batchInviting ? "邀请中…" : `邀请 ${selectedCount} 人`}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
        title={confirmLabels?.title ?? ""}
        confirmLabel={confirmLabels?.confirmLabel}
        tone="danger"
        busy={removeOrLeave.isPending}
        onConfirm={runConfirm}
      />
    </>
  );
}

function InviteRoleMenu({
  value,
  disabled,
  onChange,
}: {
  value: FolderInviteRole;
  disabled: boolean;
  onChange: (role: FolderInviteRole) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          aria-label="邀请后的角色"
          className="mt-0.5 shrink-0"
        >
          {folderRoleLabel(value)}
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {INVITE_ROLES.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => onChange(o.value)}>
            <Check
              size={14}
              className={value === o.value ? "shrink-0" : "shrink-0 opacity-0"}
            />
            <span className="flex-1 truncate">{o.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MemberRow({
  member,
  isSelf,
  isOwner,
  busy,
  onChangeRole,
  onAskConfirm,
}: {
  member: FolderMemberSummary;
  isSelf: boolean;
  isOwner: boolean;
  busy: boolean;
  onChangeRole: (role: FolderInviteRole) => void;
  onAskConfirm: (target: ConfirmTarget) => void;
}) {
  const label = personLabel({
    display_name: member.display_name,
    username: member.username,
    user_id: member.user_id,
  });
  const isPending = member.state === "pending";
  const canEditRole =
    isOwner && member.role !== "owner" && member.state === "accepted";
  const showOverflow =
    (isOwner && member.role !== "owner") || (!isOwner && isSelf);

  return (
    <li className="flex items-center gap-2 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
        {avatarInitial(label)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {label}
          {isSelf ? (
            <span className="ml-1 text-xs text-muted-foreground">（你）</span>
          ) : null}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {canEditRole ? (
            <MemberRoleMenu
              label={label}
              value={member.role === "viewer" ? "viewer" : "editor"}
              disabled={busy}
              onChange={onChangeRole}
            />
          ) : (
            <Badge tone={roleTone(member.role)} pill>
              {folderRoleLabel(member.role)}
            </Badge>
          )}
          {isPending && (
            <Badge tone="muted" pill>
              待接受
            </Badge>
          )}
        </div>
      </div>
      {showOverflow && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              disabled={busy}
              aria-label={`对 ${label} 的操作`}
              title="更多"
            >
              <MoreHorizontal size={14} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isOwner && member.role !== "owner" && (
              <DropdownMenuItem
                variant="danger"
                onSelect={() =>
                  onAskConfirm({
                    kind: isPending ? "cancel-invite" : "remove",
                    userId: member.user_id,
                    label,
                  })
                }
              >
                {isPending ? "取消邀请" : "移除"}
              </DropdownMenuItem>
            )}
            {!isOwner && isSelf && (
              <DropdownMenuItem
                variant="danger"
                onSelect={() =>
                  onAskConfirm({
                    kind: "leave",
                    userId: member.user_id,
                    label,
                  })
                }
              >
                退出
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

function MemberRoleMenu({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: FolderInviteRole;
  disabled: boolean;
  onChange: (role: FolderInviteRole) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          disabled={disabled}
          aria-label={`更改 ${label} 的角色`}
          className="h-auto px-1.5 py-0.5 text-xs font-normal"
        >
          {folderRoleLabel(value)}
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {INVITE_ROLES.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => onChange(o.value)}>
            <Check
              size={14}
              className={value === o.value ? "shrink-0" : "shrink-0 opacity-0"}
            />
            <span className="flex-1 truncate">{o.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
