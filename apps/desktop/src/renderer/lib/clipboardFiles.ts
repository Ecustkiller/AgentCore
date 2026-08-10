/**
 * 剪贴板 / 粘贴附件收集（对话 composer 与 IM 共用）。
 * 对齐行业常见做法：files + items 里的 image/*，并给占位名截图可辨认文件名。
 */

/** Chrome / Electron 剪贴板图常见占位名。 */
const GENERIC_CLIPBOARD_NAME =
  /^(image|blob|untitled)(\.(png|jpe?g|gif|webp|bmp))?$/i;

function pasteStampName(mime: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const lower = (mime || "").toLowerCase();
  const ext =
    lower === "image/jpeg" || lower === "image/jpg"
      ? ".jpg"
      : lower === "image/gif"
        ? ".gif"
        : lower === "image/webp"
          ? ".webp"
          : lower === "image/bmp"
            ? ".bmp"
            : ".png";
  return `paste-${stamp}${ext}`;
}

/** 给剪贴板截图一个可辨认文件名（避免多张都叫 image.png 撞 key）。 */
export function normalizeClipboardFileName(file: File): File {
  const raw = (file.name || "").trim();
  if (raw && !GENERIC_CLIPBOARD_NAME.test(raw)) return file;
  const mime = file.type || "image/png";
  return new File([file], pasteStampName(mime), {
    type: mime,
    lastModified: file.lastModified,
  });
}

/**
 * 收集粘贴附件：``files`` + ``items`` 里的 image/*（部分环境截图只在 items）。
 * 与白板 ``WhiteboardEngine.onPaste`` 同套路。
 */
export function collectClipboardFiles(
  data: DataTransfer | null | undefined,
): File[] {
  if (!data) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  const add = (f: File | null) => {
    if (!f || f.size <= 0) return;
    const key = `${f.name}\0${f.size}\0${f.type}\0${f.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  for (const f of Array.from(data.files ?? [])) add(f);
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    if (!item.type.startsWith("image/")) continue;
    add(item.getAsFile());
  }
  return out.map(normalizeClipboardFileName);
}
