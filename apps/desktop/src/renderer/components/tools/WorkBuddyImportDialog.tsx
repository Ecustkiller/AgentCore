import { Button, SearchField } from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { scanWorkBuddyLocal } from "@/services/workbuddyImport";
import type {
  WorkBuddyMcpCandidate,
  WorkBuddyScanResult,
  WorkBuddySkillCandidate,
} from "@shared/workbuddy-import-contract";
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from "react";

export function WorkBuddyImportDialog({
  open,
  busy,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (
    skills: readonly WorkBuddySkillCandidate[],
    mcpServers: readonly WorkBuddyMcpCandidate[],
  ) => Promise<{ failures: readonly string[] }>;
}) {
  const [scan, setScan] = useState<WorkBuddyScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [skillIds, setSkillIds] = useState<Set<string>>(new Set());
  const [mcpIds, setMcpIds] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFailures([]);
    void scanWorkBuddyLocal()
      .then((result) => {
        if (cancelled) return;
        setScan(result);
        if (result.ok) {
          setSkillIds(new Set());
          setMcpIds(
            new Set(
              result.mcpServers
                .filter((server) => server.importable)
                .map((server) => server.id),
            ),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const needle = query.trim().toLowerCase();
  const skills = useMemo(
    () =>
      scan?.ok
        ? scan.skills.filter(
            (skill) =>
              !needle ||
              skill.name.toLowerCase().includes(needle) ||
              skill.description.toLowerCase().includes(needle) ||
              skill.folder.toLowerCase().includes(needle),
          )
        : [],
    [needle, scan],
  );
  const mcpServers = useMemo(
    () =>
      scan?.ok
        ? scan.mcpServers.filter(
            (server) =>
              !needle ||
              server.name.toLowerCase().includes(needle) ||
              server.source.includes(needle),
          )
        : [],
    [needle, scan],
  );

  function toggle(setter: Dispatch<SetStateAction<Set<string>>>, id: string) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!scan?.ok) return;
    const selectedSkills = scan.skills.filter((skill) =>
      skillIds.has(skill.id),
    );
    const selectedMcp = scan.mcpServers.filter((server) =>
      mcpIds.has(server.id),
    );
    if (selectedSkills.length === 0 && selectedMcp.length === 0) return;
    const result = await onImport(selectedSkills, selectedMcp);
    setFailures(result.failures);
    if (result.failures.length === 0) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>从 WorkBuddy / SkillHub 导入</DialogTitle>
          <DialogDescription>
            只读扫描本机目录。Skill 复制为本机“我的 Skill”；MCP 凭据不会迁移。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <SearchField
            aria-label="搜索 WorkBuddy 技能"
            placeholder="搜技能或 MCP"
            value={query}
            onValueChange={setQuery}
          />
          {loading ? (
            <p className="text-xs text-muted-foreground">正在扫描本机…</p>
          ) : null}
          {scan && !scan.ok ? (
            <p className="text-xs text-destructive">{scan.error.detail}</p>
          ) : null}
          {scan?.ok ? (
            <div className="space-y-4">
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium">
                    Skills · {skills.length}
                  </h3>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setSkillIds(new Set(skills.map((skill) => skill.id)))
                    }
                  >
                    全选当前
                  </Button>
                </div>
                <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg bg-muted/30 p-2">
                  {skills.map((skill) => (
                    <li key={skill.id}>
                      <label className="flex cursor-pointer gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60">
                        <input
                          type="checkbox"
                          checked={skillIds.has(skill.id)}
                          onChange={() => toggle(setSkillIds, skill.id)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-xs font-medium">
                              {skill.name}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {skill.source}
                              {skill.skillhub ? " · SkillHub" : ""}
                            </span>
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {skill.description || skill.folder}
                          </span>
                          {skill.resourceCount > 0 ||
                          skill.configKeys.length > 0 ? (
                            <span className="block text-xs text-warning">
                              含 {skill.resourceCount} 个附加文件
                              {skill.configKeys.length
                                ? `；需另行配置 ${skill.configKeys.join("、")}`
                                : ""}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium">
                  MCP · {mcpServers.length}
                </h3>
                <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg bg-muted/30 p-2">
                  {mcpServers.map((server) => (
                    <li key={server.id}>
                      <label className="flex gap-2 rounded-lg px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={mcpIds.has(server.id)}
                          disabled={!server.importable}
                          onChange={() => toggle(setMcpIds, server.id)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">
                            {server.name} · {server.transport}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {server.importable
                              ? server.credentialKeys.length
                                ? `导入后默认禁用；需填写 ${server.credentialKeys.join("、")}`
                                : "可导入"
                              : server.reason || "当前不可导入"}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>

              {scan.warnings.length ? (
                <p className="text-xs text-muted-foreground">
                  {scan.warnings.length} 个目录无法读取，已跳过。
                </p>
              ) : null}
            </div>
          ) : null}
          {failures.length ? (
            <ul className="max-h-28 overflow-y-auto rounded-lg bg-destructive/5 p-2 text-xs text-destructive">
              {failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            size="md"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            size="md"
            disabled={busy || loading || skillIds.size + mcpIds.size === 0}
            onClick={() => void submit()}
          >
            导入选中（{skillIds.size + mcpIds.size}）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
