import {
  CanvasTexture,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from "three";

export type GroundSurfaceKind =
  | "grass"
  | "asphalt"
  | "gravel"
  | "cobble"
  | "dirt"
  | "patio"
  | "stone"
  | "lawn";

type Rgb = readonly [number, number, number];

const TEXTURE_SIZE = 128;
const textureCache = new Map<string, CanvasTexture>();

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHex(hex: string): Rgb {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  return canvas;
}

function fillBase(ctx: CanvasRenderingContext2D, rgb: Rgb): void {
  const [r, g, b] = rgb;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
}

function applyNoise(
  ctx: CanvasRenderingContext2D,
  amplitude: number,
  channelBias: Rgb = [1, 1, 1],
): void {
  const imageData = ctx.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * amplitude;
    data[i] = clampByte(data[i] + noise * channelBias[0]);
    data[i + 1] = clampByte(data[i + 1] + noise * channelBias[1]);
    data[i + 2] = clampByte(data[i + 2] + noise * channelBias[2]);
  }
  ctx.putImageData(imageData, 0, 0);
}

function drawGrass(ctx: CanvasRenderingContext2D, base: Rgb): void {
  fillBase(ctx, base);
  applyNoise(ctx, 22, [0.7, 1, 0.6]);

  const bladeCount = 180;
  const [br, bg, bb] = base;
  for (let i = 0; i < bladeCount; i += 1) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    const shade = (Math.random() - 0.5) * 18;
    ctx.strokeStyle = `rgba(${clampByte(br + shade)}, ${clampByte(bg + shade)}, ${clampByte(bb + shade * 0.5)}, 0.35)`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 2, y + 1.5 + Math.random());
    ctx.stroke();
  }
}

function drawAsphalt(ctx: CanvasRenderingContext2D, base: Rgb): void {
  fillBase(ctx, base);
  applyNoise(ctx, 14, [1, 1, 1]);

  const [br, bg, bb] = base;
  const speckleCount = 220;
  for (let i = 0; i < speckleCount; i += 1) {
    const lift = 12 + Math.random() * 28;
    ctx.fillStyle = `rgba(${clampByte(br + lift)}, ${clampByte(bg + lift)}, ${clampByte(bb + lift)}, ${0.12 + Math.random() * 0.2})`;
    ctx.fillRect(
      Math.random() * TEXTURE_SIZE,
      Math.random() * TEXTURE_SIZE,
      1,
      1,
    );
  }

  ctx.strokeStyle = `rgba(${clampByte(br + 18)}, ${clampByte(bg + 18)}, ${clampByte(bb + 18)}, 0.08)`;
  ctx.lineWidth = 1;
  for (let y = 0; y < TEXTURE_SIZE; y += 10) {
    ctx.beginPath();
    ctx.moveTo(0, y + Math.random() * 2);
    ctx.lineTo(TEXTURE_SIZE, y + Math.random() * 2);
    ctx.stroke();
  }
}

function drawGravel(ctx: CanvasRenderingContext2D, base: Rgb): void {
  fillBase(ctx, base);
  applyNoise(ctx, 18, [1, 1.02, 0.95]);

  const [br, bg, bb] = base;
  for (let i = 0; i < 160; i += 1) {
    const shift = (Math.random() - 0.5) * 30;
    const size = 0.8 + Math.random() * 1.6;
    ctx.fillStyle = `rgb(${clampByte(br + shift)}, ${clampByte(bg + shift)}, ${clampByte(bb + shift)})`;
    ctx.fillRect(
      Math.random() * TEXTURE_SIZE,
      Math.random() * TEXTURE_SIZE,
      size,
      size,
    );
  }
}

function drawCobble(ctx: CanvasRenderingContext2D, base: Rgb): void {
  const [br, bg, bb] = base;
  const mortar: Rgb = [
    clampByte(br - 22),
    clampByte(bg - 22),
    clampByte(bb - 18),
  ];
  fillBase(ctx, mortar);

  const cell = 16;
  for (let y = 0; y < TEXTURE_SIZE; y += cell) {
    for (let x = 0; x < TEXTURE_SIZE; x += cell) {
      const jitter = (Math.random() - 0.5) * 4;
      const shade = (Math.random() - 0.5) * 16;
      ctx.fillStyle = `rgb(${clampByte(br + shade)}, ${clampByte(bg + shade)}, ${clampByte(bb + shade)})`;
      ctx.fillRect(x + 1.5, y + 1.5 + jitter, cell - 3, cell - 3);
    }
  }
  applyNoise(ctx, 8, [1, 1, 1]);
}

function drawDirt(ctx: CanvasRenderingContext2D, base: Rgb): void {
  fillBase(ctx, base);
  applyNoise(ctx, 20, [1.05, 1, 0.92]);

  const [br, bg, bb] = base;
  for (let i = 0; i < 90; i += 1) {
    const shift = (Math.random() - 0.5) * 24;
    ctx.fillStyle = `rgba(${clampByte(br + shift)}, ${clampByte(bg + shift)}, ${clampByte(bb + shift)}, 0.25)`;
    const radius = 1 + Math.random() * 2.5;
    ctx.beginPath();
    ctx.ellipse(
      Math.random() * TEXTURE_SIZE,
      Math.random() * TEXTURE_SIZE,
      radius,
      radius * 0.7,
      Math.random() * Math.PI,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}

function drawPatio(ctx: CanvasRenderingContext2D, base: Rgb): void {
  fillBase(ctx, base);
  applyNoise(ctx, 14, [1.02, 1, 0.96]);

  const [br, bg, bb] = base;
  for (let i = 0; i < 120; i += 1) {
    const shift = (Math.random() - 0.5) * 14;
    ctx.fillStyle = `rgba(${clampByte(br + shift)}, ${clampByte(bg + shift)}, ${clampByte(bb + shift)}, 0.3)`;
    ctx.fillRect(
      Math.random() * TEXTURE_SIZE,
      Math.random() * TEXTURE_SIZE,
      1.2,
      1.2,
    );
  }
}

function drawStone(ctx: CanvasRenderingContext2D, base: Rgb): void {
  fillBase(ctx, base);
  applyNoise(ctx, 16, [0.98, 1, 1.04]);

  const [br, bg, bb] = base;
  ctx.strokeStyle = `rgba(${clampByte(br - 10)}, ${clampByte(bg - 10)}, ${clampByte(bb - 8)}, 0.15)`;
  ctx.lineWidth = 0.5;
  for (let i = 0; i < 6; i += 1) {
    const y = Math.random() * TEXTURE_SIZE;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TEXTURE_SIZE, y + (Math.random() - 0.5) * 6);
    ctx.stroke();
  }
}

function drawLawn(ctx: CanvasRenderingContext2D, base: Rgb): void {
  drawGrass(ctx, base);
}

const SURFACE_DRAWERS: Record<
  GroundSurfaceKind,
  (ctx: CanvasRenderingContext2D, base: Rgb) => void
> = {
  grass: drawGrass,
  asphalt: drawAsphalt,
  gravel: drawGravel,
  cobble: drawCobble,
  dirt: drawDirt,
  patio: drawPatio,
  stone: drawStone,
  lawn: drawLawn,
};

function createProceduralTexture(
  kind: GroundSurfaceKind,
  baseColor: string,
): CanvasTexture {
  const canvas = createCanvas();
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error(
      "Failed to create 2D canvas context for town ground texture",
    );
  }

  SURFACE_DRAWERS[kind](ctx, parseHex(baseColor));

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Returns a cached procedural ground texture tinted to `baseColor`. */
export function getTownGroundTexture(
  kind: GroundSurfaceKind,
  baseColor: string,
): CanvasTexture {
  const key = `${kind}:${baseColor}`;
  const cached = textureCache.get(key);
  if (cached) {
    return cached;
  }

  const texture = createProceduralTexture(kind, baseColor);
  textureCache.set(key, texture);
  return texture;
}

/** Clone a cached texture with repeat scaled to patch world size (~3m per tile). */
export function getTownGroundTextureForPatch(
  kind: GroundSurfaceKind,
  baseColor: string,
  patchSize: readonly [number, number],
  metersPerTile = 3,
): Texture {
  const source = getTownGroundTexture(kind, baseColor);
  const texture = source.clone();
  texture.repeat.set(
    patchSize[0] / metersPerTile,
    patchSize[1] / metersPerTile,
  );
  texture.needsUpdate = true;
  return texture;
}
