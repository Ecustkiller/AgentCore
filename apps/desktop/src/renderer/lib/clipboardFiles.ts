/**
 * 剪贴板 / 粘贴附件收集（对话 composer 与 IM 共用）。
 * 单一来源取文件（files 优先、items 兜底），并给占位名截图可辨认且唯一的文件名。
 */

/** Chrome / Electron 剪贴板图常见占位名。 */
const GENERIC_CLIPBOARD_NAME =
  /^(image|blob|untitled)(\.(png|jpe?g|gif|webp|bmp))?$/i;

/** 同一进程内连粘的序号；秒级时间戳单独用会撞名。 */
let pasteSeq = 0;

/**
 * 撞名的代价是丢图：云端与本机落盘都按名字静默覆盖，两边还都回 ok。自增段保证同
 * 一进程内必不同，随机段隔开多端 / 多进程同秒粘进同一会话。
 */
function pasteUniqueToken(): string {
  pasteSeq += 1;
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${rand}${pasteSeq.toString(36)}`;
}

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
  return `paste-${stamp}-${pasteUniqueToken()}${ext}`;
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
 * 收集粘贴附件：以 ``files`` 为准，只有它一个可用文件都没给出时才回落 ``items``
 * 里的 image/*（部分环境截图确实只在 items）。
 *
 * 两条通道都收会稳定出双份：``items.getAsFile()`` 每次都现读现造一个新 File，内容
 * 与名字都相同，``lastModified`` 却是构造那一刻，按值去重根本对不上；大图还要多解
 * 一次码。单一来源让唯一性由收集层保证，下游不必再兜一层去重。
 */
export function collectClipboardFiles(
  data: DataTransfer | null | undefined,
): File[] {
  if (!data) return [];
  const out: File[] = [];
  const add = (f: File | null) => {
    if (!f || f.size <= 0) return;
    out.push(f);
  };
  for (const f of Array.from(data.files ?? [])) add(f);
  if (out.length === 0) {
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== "file") continue;
      if (!item.type.startsWith("image/")) continue;
      add(item.getAsFile());
    }
  }
  return out.map(normalizeClipboardFileName);
}
