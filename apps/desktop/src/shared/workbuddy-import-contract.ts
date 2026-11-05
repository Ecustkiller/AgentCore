/** Local WorkBuddy / SkillHub discovery for explicit user import. */

export const WORKBUDDY_IMPORT_CHANNELS = {
  scan: "workbuddy:scan",
  readSkills: "workbuddy:readSkills",
} as const;

export interface WorkBuddySkillCandidate {
  id: string;
  name: string;
  description: string;
  source: "workbuddy" | "workbuddyvpc";
  folder: string;
  skillhub: boolean;
  resourceCount: number;
  configKeys: string[];
}

export interface WorkBuddySkillText {
  id: string;
  body: string;
}

export interface WorkBuddyMcpCandidate {
  id: string;
  name: string;
  source: "workbuddy" | "workbuddyvpc";
  transport: "stdio" | "http" | "unsupported";
  command: string;
  args: string[];
  env: Record<string, string>;
  credentialKeys: string[];
  url?: string;
  importable: boolean;
  reason?: string;
}

export type WorkBuddyScanResult =
  | {
      ok: true;
      roots: string[];
      skills: WorkBuddySkillCandidate[];
      mcpServers: WorkBuddyMcpCandidate[];
      warnings: string[];
    }
  | { ok: false; error: { kind: string; detail: string } };

export interface WorkBuddyImportApi {
  scan: () => Promise<WorkBuddyScanResult>;
  readSkills: (ids: readonly string[]) => Promise<WorkBuddySkillText[]>;
}
