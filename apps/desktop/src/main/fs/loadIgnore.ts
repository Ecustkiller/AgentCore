import { promises as fs } from "node:fs";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";
import {
  BASELINES_REL,
  INDEX_REL,
  LIST_FILES_SKIP_DIRS,
  TRASH_REL,
  VERSIONS_REL,
} from "./workspaceIgnore";

/**
 * 载入忽略规则：默认跳过集 + 路径感知内部区 + 根 `.gitignore`（缺失则仅默认集）。
 * 每个根只应调用一次（调用方在 walk 前缓存），不要按文件重复读盘。
 */
export async function loadIgnore(rootAbs: string): Promise<Ignore> {
  const ig = ignore();
  // 默认跳过集按目录规则加入（"name/" 匹配整棵子树）+ *.db。
  ig.add([...LIST_FILES_SKIP_DIRS].map((d) => `${d}/`));
  ig.add([
    `${INDEX_REL}/`,
    `${TRASH_REL}/`,
    `${BASELINES_REL}/`,
    `${VERSIONS_REL}/`,
  ]);
  ig.add(["*.db"]);
  try {
    ig.add(await fs.readFile(join(rootAbs, ".gitignore"), "utf-8"));
  } catch {
    // 无 .gitignore —— 仅用默认集
  }
  return ig;
}
