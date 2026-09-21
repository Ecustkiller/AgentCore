/**
 * Denser-than-default flowchart layout for chat figures. Mermaid's stock
 * nodeSpacing/rankSpacing (50) plus 16px labels make a TD stack taller than a
 * reading column; the inline card contain-fits into an explicit pixel box
 * (Diagram.tsx). wrappingWidth stays at mermaid's 200 so CJK node text still
 * wraps instead of inflating node boxes.
 *
 * useMaxWidth must stay true: false emits a bare pixel width with no CSS
 * max-width, and stretching that SVG to the column enlarges compact charts
 * (239×677 → 616×1744 in Chromium).
 *
 * Palette comes from design tokens (not mermaid's stock default/dark).
 * Mermaid's theme engine only accepts hex; alpha borders are rgba(). khroma
 * rejects oklch(), so this module converts OKLCH to sRGB at that boundary.
 * Fallbacks match tokens.css :root / .dark and go through the same converter.
 * An unrecognized live value is not forwarded.
 *
 * Do not `import "mermaid"` from this module — the renderer lazy-loads it
 * (Vite deps race; see Diagram.tsx).
 */
export const MERMAID_FLOWCHART_LAYOUT = {
  nodeSpacing: 32,
  rankSpacing: 36,
  diagramPadding: 8,
  padding: 8,
  wrappingWidth: 200,
  useMaxWidth: true,
} as const;

/** Body-adjacent label size (markdown-body --text-sm ≈ 0.875rem), not mermaid's 16. */
export const MERMAID_FONT_SIZE_PX = 14;

type TokenPaint = {
  background: string;
  foreground: string;
  card: string;
  muted: string;
  mutedForeground: string;
  border: string;
  destructive: string;
};

/** Keep in sync with packages/design-tokens/src/tokens.css (:root / .dark). */
const TOKEN_PAINT: { light: TokenPaint; dark: TokenPaint } = {
  light: {
    background: "oklch(1 0 0)",
    foreground: "oklch(0.15 0.01 255)",
    card: "oklch(1 0 0)",
    muted: "oklch(0.97 0.006 255)",
    mutedForeground: "oklch(0.55 0.02 255)",
    border: "oklch(0.92 0.008 255)",
    destructive: "oklch(0.58 0.22 27)",
  },
  dark: {
    background: "oklch(0.13 0.004 255)",
    foreground: "oklch(0.93 0.005 255)",
    card: "oklch(0.185 0.004 255)",
    muted: "oklch(0.225 0.005 255)",
    mutedForeground: "oklch(0.72 0.01 255)",
    border: "oklch(1 0 0 / 0.12)",
    destructive: "oklch(0.65 0.19 27)",
  },
};

function readToken(name: string, fallback: string): string {
  if (
    typeof document === "undefined" ||
    typeof getComputedStyle !== "function"
  ) {
    return fallback;
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw || raw.includes("var(")) return fallback;
  return raw;
}

/**
 * OKLab → XYZ → linear sRGB (Ottosson / CSS Color 4, color.js coefficients).
 * Channel clip stands in for CSS gamut mapping; the tokens in TOKEN_PAINT sit
 * inside sRGB, and their 8-bit values match Chromium's sRGB canvas.
 */
const OKLAB_TO_LMS = [
  [0.9999999984505198, 0.39633779217376786, 0.2158037580607588],
  [1.0000000088817609, -0.10556134232365635, -0.06385417477170591],
  [1.0000000546724108, -0.08948418209496575, -1.2914855378640917],
] as const;

const LMS_TO_XYZ = [
  [1.2268798733741557, -0.5578149965554813, 0.28139105017721583],
  [-0.04057576262431372, 1.1122868032803173, -0.07171104155301115],
  [-0.07637294974672142, -0.4214933324022432, 1.5869240244272418],
] as const;

const XYZ_TO_LINEAR_SRGB = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
] as const;

type Vec3 = readonly [number, number, number];
type Mat3 = readonly [Vec3, Vec3, Vec3];

function apply(m: Mat3, v: Vec3): [number, number, number] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function srgbEncode(channel: number): number {
  const abs = Math.abs(channel);
  const sign = channel < 0 ? -1 : 1;
  if (abs <= 0.0031308) return sign * 12.92 * abs;
  return sign * (1.055 * abs ** (1 / 2.4) - 0.055);
}

function srgbByte(channel: number): number {
  const encoded = Math.min(1, Math.max(0, srgbEncode(channel)));
  return Math.round(encoded * 255);
}

function hexByte(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function formatMermaidColor(
  r: number,
  g: number,
  b: number,
  alpha: number,
): string {
  const R = Math.min(255, Math.max(0, Math.round(r)));
  const G = Math.min(255, Math.max(0, Math.round(g)));
  const B = Math.min(255, Math.max(0, Math.round(b)));
  if (alpha >= 1) return `#${hexByte(R)}${hexByte(G)}${hexByte(B)}`;
  const a = Math.min(1, Math.max(0, alpha));
  const rounded = Math.round(a * 10000) / 10000;
  return `rgba(${R}, ${G}, ${B}, ${rounded})`;
}

function oklchToSrgbBytes(
  L: number,
  C: number,
  H: number,
): [number, number, number] {
  const hue = (H * Math.PI) / 180;
  const lmsC = apply(OKLAB_TO_LMS, [L, C * Math.cos(hue), C * Math.sin(hue)]);
  const lms: [number, number, number] = [
    lmsC[0] ** 3,
    lmsC[1] ** 3,
    lmsC[2] ** 3,
  ];
  const linear = apply(XYZ_TO_LINEAR_SRGB, apply(LMS_TO_XYZ, lms));
  return [srgbByte(linear[0]), srgbByte(linear[1]), srgbByte(linear[2])];
}

function unitless(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (t === "none") return 0;
  const n = Number(t.endsWith("deg") ? t.slice(0, -3) : t);
  return Number.isFinite(n) ? n : null;
}

function parseAlpha(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  const t = raw.trim().toLowerCase();
  if (t === "none") return 0;
  if (t.endsWith("%")) {
    const n = Number(t.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function fromOklch(color: string): string | null {
  const m = /^oklch\(\s*(\S+)\s+(\S+)\s+(\S+)(?:\s*\/\s*(\S+))?\s*\)$/i.exec(
    color,
  );
  if (!m) return null;
  const L = unitless(m[1]);
  const C = unitless(m[2]);
  const H = unitless(m[3]);
  const alpha = parseAlpha(m[4]);
  if (L === null || C === null || H === null || alpha === null) return null;
  const [r, g, b] = oklchToSrgbBytes(L, C, H);
  return formatMermaidColor(r, g, b, alpha);
}

function fromHex(color: string): string | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color);
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h].map((ch) => ch + ch).join("");
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  const alpha = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1;
  return formatMermaidColor(r, g, b, alpha);
}

function rgbChannel(raw: string): number | null {
  if (raw.endsWith("%")) {
    const n = Number(raw.slice(0, -1));
    if (!Number.isFinite(n)) return null;
    return (Math.min(100, Math.max(0, n)) / 100) * 255;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(255, Math.max(0, n));
}

function fromRgb(color: string): string | null {
  const m =
    /^rgba?\(\s*([0-9.]+%?)\s*[, ]\s*([0-9.]+%?)\s*[, ]\s*([0-9.]+%?)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i.exec(
      color,
    );
  if (!m) return null;
  const r = rgbChannel(m[1]);
  const g = rgbChannel(m[2]);
  const b = rgbChannel(m[3]);
  const alpha = parseAlpha(m[4]);
  if (r === null || g === null || b === null || alpha === null) return null;
  return formatMermaidColor(r, g, b, alpha);
}

function convertMermaidColor(color: string): string | null {
  const trimmed = color.trim();
  return fromOklch(trimmed) ?? fromHex(trimmed) ?? fromRgb(trimmed);
}

/**
 * Khroma-legal color. An unrecognized `color` uses `fallback`.
 * Both failing yields black, which khroma can still parse.
 */
export function toMermaidColor(color: string, fallback: string): string {
  return (
    convertMermaidColor(color) ?? convertMermaidColor(fallback) ?? "#000000"
  );
}

function paint(dark: boolean): TokenPaint {
  const fb = dark ? TOKEN_PAINT.dark : TOKEN_PAINT.light;
  return {
    background: toMermaidColor(
      readToken("--background", fb.background),
      fb.background,
    ),
    foreground: toMermaidColor(
      readToken("--foreground", fb.foreground),
      fb.foreground,
    ),
    card: toMermaidColor(readToken("--card", fb.card), fb.card),
    muted: toMermaidColor(readToken("--muted", fb.muted), fb.muted),
    mutedForeground: toMermaidColor(
      readToken("--muted-foreground", fb.mutedForeground),
      fb.mutedForeground,
    ),
    border: toMermaidColor(readToken("--border", fb.border), fb.border),
    destructive: toMermaidColor(
      readToken("--destructive", fb.destructive),
      fb.destructive,
    ),
  };
}

export function mermaidThemeVariables(dark: boolean) {
  const t = paint(dark);
  return {
    darkMode: dark,
    background: t.background,
    fontSize: `${MERMAID_FONT_SIZE_PX}px`,
    primaryColor: t.card,
    primaryTextColor: t.foreground,
    primaryBorderColor: t.border,
    secondaryColor: t.muted,
    secondaryTextColor: t.foreground,
    secondaryBorderColor: t.border,
    tertiaryColor: t.background,
    tertiaryTextColor: t.mutedForeground,
    tertiaryBorderColor: t.border,
    lineColor: t.mutedForeground,
    textColor: t.foreground,
    mainBkg: t.card,
    nodeBorder: t.border,
    clusterBkg: t.muted,
    clusterBorder: t.border,
    titleColor: t.foreground,
    edgeLabelBackground: t.background,
    noteBkgColor: t.muted,
    noteTextColor: t.foreground,
    noteBorderColor: t.border,
    errorBkgColor: t.destructive,
    errorTextColor: t.foreground,
    altSectionBkgColor: t.background,
    useGradient: false,
    dropShadow: "none",
  };
}

export function mermaidRenderConfig(dark: boolean) {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: "base" as const,
    fontFamily: "inherit",
    fontSize: MERMAID_FONT_SIZE_PX,
    themeVariables: mermaidThemeVariables(dark),
    flowchart: { ...MERMAID_FLOWCHART_LAYOUT },
  };
}
