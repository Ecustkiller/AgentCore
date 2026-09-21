import { FACE_META, FACE_ORDER } from "@/components/tools/catalogMeta";
import {
  type PromptCatalogItem,
  SKILL_GROUP_ORDER,
  skillCatalogId,
  toolCatalogId,
} from "@/lib/promptCatalog";
import type {
  Capabilities,
  CapabilitySkill,
  CapabilityTool,
} from "@/services/capabilities";

export type FactoryGuideItem = Extract<
  PromptCatalogItem,
  { kind: "skill" | "tool" }
>;

export type FactoryGuideSection = {
  id: string;
  title: string;
  items: FactoryGuideItem[];
};

const OTHER_HOW_GROUP = "用法";

function isSkillGroup(
  value: string,
): value is (typeof SKILL_GROUP_ORDER)[number] {
  return (SKILL_GROUP_ORDER as readonly string[]).includes(value);
}

function toSkillItem(
  skill: CapabilitySkill,
): Extract<PromptCatalogItem, { kind: "skill" }> {
  return {
    id: skillCatalogId(skill.name),
    kind: "skill",
    group: "factory",
    label: skill.summary,
    depth: 0,
    tocGroup: skill.group?.trim() ?? "",
    skill,
    parentId: null,
  };
}

function toToolItem(
  tool: CapabilityTool,
): Extract<PromptCatalogItem, { kind: "tool" }> {
  return {
    id: toolCatalogId(tool.name),
    kind: "tool",
    group: "factory",
    label: tool.name,
    depth: 0,
    tool,
    parentId: null,
  };
}

/** 说明书深页：官方 HOW 按决策组，出厂工具按能力面。 */
export function buildFactoryGuide(data: Capabilities): FactoryGuideSection[] {
  const sections: FactoryGuideSection[] = [];
  const howBuckets = new Map<string, FactoryGuideItem[]>();
  for (const skill of data.skills) {
    const item = toSkillItem(skill);
    const key = isSkillGroup(item.tocGroup) ? item.tocGroup : OTHER_HOW_GROUP;
    const bucket = howBuckets.get(key) ?? [];
    bucket.push(item);
    howBuckets.set(key, bucket);
  }
  for (const group of SKILL_GROUP_ORDER) {
    const items = howBuckets.get(group);
    if (items?.length) {
      sections.push({ id: `how:${group}`, title: group, items });
    }
  }
  const otherHow = howBuckets.get(OTHER_HOW_GROUP);
  if (otherHow?.length) {
    sections.push({ id: "how:other", title: OTHER_HOW_GROUP, items: otherHow });
  }

  const toolsByFace = new Map<string, FactoryGuideItem[]>();
  for (const tool of data.tools) {
    const item = toToolItem(tool);
    const bucket = toolsByFace.get(item.tool.face) ?? [];
    bucket.push(item);
    toolsByFace.set(item.tool.face, bucket);
  }
  for (const face of FACE_ORDER) {
    const items = toolsByFace.get(face);
    if (!items?.length) continue;
    sections.push({
      id: `face:${face}`,
      title: FACE_META[face].label,
      items,
    });
  }
  return sections;
}

export function flattenFactoryGuide(
  sections: FactoryGuideSection[],
): FactoryGuideItem[] {
  return sections.flatMap((section) => section.items);
}

export function filterFactoryGuide(
  sections: FactoryGuideSection[],
  query: string,
): FactoryGuideSection[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sections;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => guideItemMatches(item, needle)),
    }))
    .filter((section) => section.items.length > 0);
}

function guideItemMatches(item: FactoryGuideItem, needle: string): boolean {
  if (item.kind === "skill") {
    const haystack = [
      item.label,
      item.skill.name,
      item.skill.blurb ?? "",
      item.skill.summary,
    ]
      .join("\n")
      .toLowerCase();
    return haystack.includes(needle);
  }
  const haystack = [
    item.tool.summary,
    item.tool.blurb ?? "",
    item.tool.name,
    item.label,
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}
