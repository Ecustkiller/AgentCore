import {
  type AskUserContent,
  composeAnswer,
} from "@/components/chat/ask/AskUserFields";
import type { WorkspaceBinding } from "@/services/workspaceBinding";
import type { FsRoot } from "@shared/ipc-contract";
import { describe, expect, it } from "vitest";
import { formatBindLocalFolderAnswer } from "../bindLocalFolder";
import { formatOpenLocalProjectAnswer } from "../openLocalProject";
import { formatRegisterLocalProjectAnswer } from "../registerLocalProject";
import {
  formatWorkspaceChipLabel,
  formatWorkspaceChipTitle,
  resolveEffectiveWorkspace,
} from "../workspaceEffectiveMode";

const roots: FsRoot[] = [
  { id: "root-bound", name: "MyRepo" },
  { id: "root-container", name: "AgentCore" },
];

const cloud: WorkspaceBinding = {
  mode: "cloud",
  scope: "conversation",
  rootId: null,
  source: null,
};

const localBound: WorkspaceBinding = {
  mode: "local",
  scope: "conversation",
  rootId: "root-bound",
  source: "explicit",
};

const projectLocal: WorkspaceBinding = {
  mode: "local",
  scope: "folder",
  rootId: "root-bound",
  source: "explicit",
};

describe("formatBindLocalFolderAnswer", () => {
  it("appends the folder name so the AI knows what was bound", () => {
    expect(formatBindLocalFolderAnswer("绑定本机执行环境", "docs")).toBe(
      "绑定本机执行环境（docs）",
    );
  });
});

describe("formatOpenLocalProjectAnswer", () => {
  it("marks the open as a new local project session", () => {
    expect(formatOpenLocalProjectAnswer("打开本地项目", "MyRepo")).toBe(
      "打开本地项目（MyRepo · 已打开为本地项目，新会话）",
    );
  });
});

describe("formatRegisterLocalProjectAnswer", () => {
  it("marks registration as staying on the current conversation", () => {
    expect(formatRegisterLocalProjectAnswer("登记本地项目", "MyRepo")).toBe(
      "登记本地项目（MyRepo · 已登记为本地项目，仍在本对话）",
    );
  });
});

describe("composeAnswer with bind_local_folder pick", () => {
  const content: AskUserContent = {
    question: "需要本地目录吗？",
    context: "",
    assumptions: [],
    questions: [
      {
        id: "q0",
        prompt: "工作区",
        kind: "choice",
        options: [
          { label: "打开本地项目", action: "open_local_project" },
          { label: "登记本地项目", action: "register_local_project" },
          { label: "绑定本机执行环境", action: "bind_local_folder" },
          { label: "继续用云端" },
        ],
        multiple: false,
        default: "",
      },
    ],
  };

  it("puts the folder-annotated option into the composed resolve text", () => {
    const text = composeAnswer(
      content,
      {
        q0: [
          formatBindLocalFolderAnswer("绑定本机执行环境", "AgentCore-desktop"),
        ],
      },
      {},
      {},
      "",
    );
    expect(text).toContain("绑定本机执行环境（AgentCore-desktop）");
    expect(text).toMatch(/^我的答复：/);
  });

  it("composes open_local_project answer without implying current-session bind", () => {
    const text = composeAnswer(
      content,
      {
        q0: [formatOpenLocalProjectAnswer("打开本地项目", "AgentCore")],
      },
      {},
      {},
      "",
    );
    expect(text).toContain(
      "打开本地项目（AgentCore · 已打开为本地项目，新会话）",
    );
  });

  it("composes register_local_project answer as same-conversation registration", () => {
    const text = composeAnswer(
      content,
      {
        q0: [formatRegisterLocalProjectAnswer("登记本地项目", "AgentCore")],
      },
      {},
      {},
      "",
    );
    expect(text).toContain(
      "登记本地项目（AgentCore · 已登记为本地项目，仍在本对话）",
    );
    expect(text).not.toContain("新会话");
  });
});

describe("resolveEffectiveWorkspace (chip status source)", () => {
  it("treats an explicit bind as local with that root name", () => {
    const ws = resolveEffectiveWorkspace({
      binding: localBound,
      localContainerRootId: "root-container",
      roots,
    });
    expect(ws.isLocal).toBe(true);
    expect(ws.rootId).toBe("root-bound");
    expect(ws.rootName).toBe("MyRepo");
    expect(ws.viaContainer).toBe(false);
    expect(formatWorkspaceChipLabel(ws)).toBe("本机草稿");
  });

  it("labels project inheritance as project name only", () => {
    const ws = resolveEffectiveWorkspace({
      binding: projectLocal,
      localContainerRootId: null,
      roots,
      projectName: "Acme",
    });
    expect(ws.viaProject).toBe(true);
    expect(formatWorkspaceChipLabel(ws)).toBe("Acme");
    expect(formatWorkspaceChipTitle(ws)).toBe(
      "本机传统（本机文件夹权威，≠离线）",
    );
  });

  it("treats default container root as local when binding is cloud", () => {
    const ws = resolveEffectiveWorkspace({
      binding: cloud,
      localContainerRootId: "root-container",
      roots,
    });
    expect(ws.isLocal).toBe(true);
    expect(ws.viaContainer).toBe(true);
    expect(formatWorkspaceChipLabel(ws)).toBe("本机草稿");
    expect(formatWorkspaceChipTitle(ws)).toBe(
      "本机草稿（文件落本机默认目录，不算项目）",
    );
  });

  it("shows 云端对话 when neither bind nor container is set", () => {
    const ws = resolveEffectiveWorkspace({
      binding: cloud,
      localContainerRootId: null,
      roots,
    });
    expect(ws.isLocal).toBe(false);
    expect(formatWorkspaceChipLabel(ws)).toBe("云端对话");
    expect(formatWorkspaceChipTitle(ws)).toBe("云端对话");
  });

  it("labels cloud project as project name only", () => {
    const projectCloud: WorkspaceBinding = {
      mode: "cloud",
      scope: "folder",
      rootId: null,
      source: null,
    };
    const ws = resolveEffectiveWorkspace({
      binding: projectCloud,
      localContainerRootId: null,
      roots,
      projectName: "Acme",
    });
    expect(ws.isLocal).toBe(false);
    expect(ws.viaProject).toBe(true);
    expect(formatWorkspaceChipLabel(ws)).toBe("Acme");
    expect(formatWorkspaceChipTitle(ws)).toBe("云端对话");
  });
});
