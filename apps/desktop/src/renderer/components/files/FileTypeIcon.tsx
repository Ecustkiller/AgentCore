/**
 * VS Code Material 风格文件/目录类型图标。
 * 内嵌品牌色为例外（见 color-tokens / UI-Pattern 登记）；勿再包一层 text-* 染色。
 *
 * 上游 FileIcon 只做 fileNames 精确匹配、不会从文件名拆扩展名；
 * 本仓在此补：小写 → 整名 → 最长复合后缀，避免 *.ts / README.md 掉通用 file。
 */
import {
  FolderIcon as MaterialFolderIcon,
  MaterialIcon,
  getFileIcon,
} from "react-material-icon-theme";

/** 本仓以 React 为主；启用 react pack，避免默认 angular 抢特定后缀。 */
const ICON_PACK = "react";
const FALLBACK = "file";

function basename(pathOrName: string): string {
  const normalized = pathOrName.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || pathOrName;
}

/** 最长优先：`foo.test.tsx` → test.tsx, tsx；`types.d.ts` → d.ts, ts；`.env` → env。 */
function extensionCandidates(fileName: string): string[] {
  const parts = fileName.split(".");
  if (parts.length < 2) return [];
  // 跳过第一段（主名或点文件空段），从第二段起拼复合后缀。
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(i).join("."));
  }
  return out;
}

/** 供单测；返回 Material 图标名（非 SVG）。 */
export function resolveMaterialFileIconName(
  nameOrPath: string | undefined,
): string {
  const raw = basename(nameOrPath || "file");
  const fileName = raw.toLowerCase();

  const byName = getFileIcon({
    fileName,
    iconPack: ICON_PACK,
    fallback: FALLBACK,
  });
  if (byName !== FALLBACK) return byName;

  for (const fileExtension of extensionCandidates(fileName)) {
    const byExt = getFileIcon({
      fileExtension,
      iconPack: ICON_PACK,
      fallback: FALLBACK,
    });
    if (byExt !== FALLBACK) return byExt;
  }

  return FALLBACK;
}

export function FileTypeIcon({
  name,
  path,
  size = 13,
  className,
}: {
  /** 文件名（可含扩展名）；与 path 二选一，优先 name。 */
  name?: string;
  path?: string;
  size?: number;
  className?: string;
}) {
  const iconName = resolveMaterialFileIconName(name || path);
  return (
    <MaterialIcon
      name={iconName}
      size={size}
      // 避免库内 title=「xxx icon」抢父级 tooltip；点击仍由父行承接。
      className={`pointer-events-none shrink-0 ${className ?? ""}`.trim()}
    />
  );
}

export function DirTypeIcon({
  name,
  path,
  isOpen = false,
  size = 13,
  className,
}: {
  name?: string;
  path?: string;
  isOpen?: boolean;
  size?: number;
  className?: string;
}) {
  const folderName = basename(name || path || "").toLowerCase();
  return (
    <MaterialFolderIcon
      folderName={folderName || undefined}
      isOpen={isOpen}
      size={size}
      className={`pointer-events-none shrink-0 ${className ?? ""}`.trim()}
      theme="specific"
    />
  );
}
