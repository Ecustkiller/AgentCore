import { createRuleDocument } from "@/services/documents";
import {
  composeOnDemandSkillContent,
  skillFileName,
} from "@/services/skillCatalog";
import type { McpServerConfig } from "@shared/mcp-contract";
import type {
  WorkBuddyMcpCandidate,
  WorkBuddyScanResult,
  WorkBuddySkillCandidate,
  WorkBuddySkillText,
} from "@shared/workbuddy-import-contract";

export function scanWorkBuddyLocal(): Promise<WorkBuddyScanResult> {
  const api =
    typeof window !== "undefined" ? window.workbuddyImportApi : undefined;
  if (!api) {
    return Promise.resolve({
      ok: false,
      error: {
        kind: "NotDesktop",
        detail: "本地 WorkBuddy 导入仅在桌面应用可用",
      },
    });
  }
  return api.scan();
}

export async function importWorkBuddySkills(
  candidates: readonly WorkBuddySkillCandidate[],
  options: {
    parentId: string;
    existingNames: readonly string[];
  },
): Promise<{ imported: number; failures: string[] }> {
  const api =
    typeof window !== "undefined" ? window.workbuddyImportApi : undefined;
  if (!api) {
    return { imported: 0, failures: ["当前环境没有 WorkBuddy 文件通道"] };
  }
  const skillTexts: WorkBuddySkillText[] = await api.readSkills(
    candidates.map((candidate) => candidate.id),
  );
  const bodies = new Map(skillTexts.map((item) => [item.id, item.body]));
  const names = new Set(
    options.existingNames.map((name) => name.toLowerCase()),
  );
  const failures: string[] = [];
  let imported = 0;
  for (const candidate of candidates) {
    const body = bodies.get(candidate.id);
    if (body === undefined) {
      failures.push(`${candidate.name}: 源文件已不可读取`);
      continue;
    }
    let name = skillFileName(candidate.name);
    let suffix = 2;
    while (names.has(name.toLowerCase())) {
      name = skillFileName(`${candidate.name} (${suffix})`);
      suffix += 1;
    }
    try {
      await createRuleDocument(
        name,
        null,
        composeOnDemandSkillContent(candidate.description, body),
        "on_demand",
        options.parentId,
      );
      names.add(name.toLowerCase());
      imported += 1;
    } catch (error) {
      failures.push(
        `${candidate.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { imported, failures };
}

export function toNexusMcpConfig(
  candidate: WorkBuddyMcpCandidate,
): McpServerConfig {
  return {
    id: candidate.id,
    name: `[WorkBuddy] ${candidate.name}`,
    enabled: candidate.importable && candidate.credentialKeys.length === 0,
    transport: candidate.transport === "http" ? "http" : "stdio",
    command: candidate.command,
    args: candidate.args,
    env: candidate.env,
    ...(candidate.url ? { url: candidate.url } : {}),
  };
}

export async function importWorkBuddyMcp(
  candidates: readonly WorkBuddyMcpCandidate[],
): Promise<{ imported: number; failures: string[] }> {
  const api = typeof window !== "undefined" ? window.mcpApi : undefined;
  if (!api) {
    return {
      imported: 0,
      failures: ["当前环境没有本机 MCP 配置通道"],
    };
  }
  const failures: string[] = [];
  let imported = 0;
  for (const candidate of candidates) {
    if (!candidate.importable) {
      failures.push(`${candidate.name}: ${candidate.reason || "当前不可导入"}`);
      continue;
    }
    try {
      const result = await api.upsertServer(toNexusMcpConfig(candidate));
      if (result.ok) imported += 1;
      else failures.push(`${candidate.name}: ${result.error.detail}`);
    } catch (error) {
      failures.push(
        `${candidate.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { imported, failures };
}
