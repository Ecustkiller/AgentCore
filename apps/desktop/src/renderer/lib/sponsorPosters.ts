export type SponsorPosterKind = "wechat" | "alipay";

export type SponsorPosters = Partial<Record<SponsorPosterKind, string>>;

const POSTER_STEMS = new Set<string>(["wechat", "alipay"]);

/** Map Vite glob keys (`…/wechat.png`) onto the two poster slots. */
export function resolveSponsorPosters(
  modules: Record<string, string>,
): SponsorPosters {
  const out: SponsorPosters = {};
  for (const [path, url] of Object.entries(modules)) {
    const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
    const stem = base.replace(/\.(png|jpe?g|webp)$/i, "").toLowerCase();
    if (POSTER_STEMS.has(stem) && url) {
      out[stem as SponsorPosterKind] = url;
    }
  }
  return out;
}

const modules = import.meta.glob<string>(
  "../assets/support/*.{png,jpg,jpeg,webp}",
  { eager: true, import: "default", query: "?url" },
);

/** Present only when this build's tree has gitignored poster files. */
export const SPONSOR_POSTERS = resolveSponsorPosters(modules);
