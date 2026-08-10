import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import {
  DocumentsApiError,
  createRuleDocument,
  deleteDocument,
  getDocument,
  isDocumentsUnavailable,
  listDocuments,
  listUserRules,
  renameDocument,
  toApplyMode,
  updateDocumentApplyMode,
  writeDocument,
} from "../documents";

function okJson(body: unknown, status = 200) {
  return {
    ok: true,
    status,
    json: async () => body,
  };
}

function fail(status: number) {
  return { ok: false, status, json: async () => ({}) };
}

const node = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  parent_id: null,
  folder_id: null,
  kind: "document",
  role: "rule",
  ai_maintained: false,
  apply_mode: "always",
  name: "语气规则.md",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

beforeEach(() => {
  apiFetch.mockReset();
});

describe("toApplyMode", () => {
  it("maps on_demand; everything else → always", () => {
    expect(toApplyMode("on_demand")).toBe("on_demand");
    expect(toApplyMode("always")).toBe("always");
    expect(toApplyMode("conditional")).toBe("always");
    expect(toApplyMode("")).toBe("always");
  });
});

describe("listDocuments / listUserRules", () => {
  it("GET /v1/documents → camelCase nodes", async () => {
    apiFetch.mockResolvedValue(okJson([node({ apply_mode: "on_demand" })]));
    await expect(listDocuments(null)).resolves.toEqual([
      {
        id: "r1",
        parentId: null,
        folderId: null,
        kind: "document",
        role: "rule",
        aiMaintained: false,
        applyMode: "on_demand",
        name: "语气规则.md",
      },
    ]);
    expect(apiFetch).toHaveBeenCalledWith("/v1/documents");
  });

  it("listDocuments with parent_id query", async () => {
    apiFetch.mockResolvedValue(okJson([]));
    await listDocuments("p1");
    expect(apiFetch).toHaveBeenCalledWith("/v1/documents?parent_id=p1");
  });

  it("listUserRules walks AgentCore/规则 and keeps GLOBAL only", async () => {
    apiFetch
      .mockResolvedValueOnce(
        okJson([
          node({ id: "top-global", name: "遗留.md" }),
          node({
            id: "top-project",
            name: "项目遗留.md",
            folder_id: "F1",
          }),
          {
            id: "ac",
            parent_id: null,
            folder_id: null,
            kind: "folder",
            role: "general",
            ai_maintained: false,
            apply_mode: "always",
            name: "AgentCore",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ]),
      )
      .mockResolvedValueOnce(
        okJson([
          {
            id: "rd",
            parent_id: "ac",
            folder_id: null,
            kind: "folder",
            role: "general",
            ai_maintained: false,
            apply_mode: "always",
            name: "规则",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ]),
      )
      .mockResolvedValueOnce(
        okJson([
          node({ id: "g1", name: "语气规则.md", apply_mode: "always" }),
          node({
            id: "p1",
            name: "项目规则.md",
            folder_id: "F1",
            apply_mode: "on_demand",
          }),
        ]),
      );

    const rows = await listUserRules();
    expect(rows.map((r) => r.id).sort()).toEqual(["g1", "top-global"]);
    expect(rows.find((r) => r.id === "p1")).toBeUndefined();
    expect(rows.find((r) => r.id === "top-project")).toBeUndefined();
  });

  it("HTTP 非 2xx → DocumentsApiError", async () => {
    apiFetch.mockResolvedValue(fail(500));
    await expect(listDocuments()).rejects.toBeInstanceOf(DocumentsApiError);
  });
});

describe("create / apply_mode / write / rename / delete", () => {
  it("POST createRuleDocument defaults apply_mode=always", async () => {
    apiFetch.mockResolvedValue(
      okJson({
        ...node({ id: "new", name: "新规则.md" }),
        content: "",
        version: "v1",
      }),
    );
    const doc = await createRuleDocument("新规则.md");
    expect(doc.applyMode).toBe("always");
    expect(apiFetch).toHaveBeenCalledWith("/v1/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "新规则.md",
        kind: "document",
        role: "rule",
        content: "",
        parent_id: null,
        folder_id: null,
        apply_mode: "always",
      }),
    });
  });

  it("PATCH updateDocumentApplyMode", async () => {
    apiFetch.mockResolvedValue(
      okJson({
        ...node({ apply_mode: "on_demand" }),
        content: "x",
        version: "v2",
      }),
    );
    await expect(
      updateDocumentApplyMode("r1", "on_demand"),
    ).resolves.toMatchObject({
      id: "r1",
      applyMode: "on_demand",
    });
    expect(apiFetch).toHaveBeenCalledWith("/v1/documents/r1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apply_mode: "on_demand", reparent: false }),
    });
  });

  it("GET getDocument + PUT writeDocument", async () => {
    apiFetch
      .mockResolvedValueOnce(
        okJson({ ...node(), content: "hello", version: "v1" }),
      )
      .mockResolvedValueOnce(
        okJson({ ok: true, conflict: false, version: "v2" }),
      );
    await expect(getDocument("r1")).resolves.toMatchObject({
      content: "hello",
      version: "v1",
    });
    await expect(writeDocument("r1", "hi", "v1")).resolves.toEqual({
      ok: true,
      conflict: false,
      version: "v2",
    });
    expect(apiFetch).toHaveBeenLastCalledWith("/v1/documents/r1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi", baseline: "v1" }),
    });
  });

  it("renameDocument + deleteDocument", async () => {
    apiFetch
      .mockResolvedValueOnce(
        okJson({
          ...node({ name: "新名.md" }),
          content: "",
          version: "v1",
        }),
      )
      .mockResolvedValueOnce(
        okJson({ ok: true, conflict: false, version: "v1" }),
      );
    await expect(renameDocument("r1", "新名.md")).resolves.toMatchObject({
      name: "新名.md",
    });
    await expect(deleteDocument("r1")).resolves.toMatchObject({ ok: true });
    expect(apiFetch).toHaveBeenLastCalledWith("/v1/documents/r1", {
      method: "DELETE",
      headers: undefined,
      body: undefined,
    });
  });
});

describe("isDocumentsUnavailable", () => {
  it("404/501 → true; others false", () => {
    expect(isDocumentsUnavailable(new DocumentsApiError(404, "x"))).toBe(true);
    expect(isDocumentsUnavailable(new DocumentsApiError(501, "x"))).toBe(true);
    expect(isDocumentsUnavailable(new DocumentsApiError(500, "x"))).toBe(false);
    expect(isDocumentsUnavailable(new Error("x"))).toBe(false);
  });
});
