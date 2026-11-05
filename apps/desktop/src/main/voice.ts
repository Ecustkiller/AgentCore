import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  VOICE_CHANNELS,
  type VoiceModelProgress,
  type VoicePrepareResult,
  type VoiceStatus,
  type VoiceTranscribeResult,
} from "@shared/voice-contract";
import { type BrowserWindow, app, ipcMain } from "electron";
import { downloadHttpToFile } from "./installer-download";

const execFileAsync = promisify(execFile);

const MODEL_FILE = "ggml-base.bin";
const MODEL_URLS = [
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
] as const;
const MODEL_MIN_BYTES = 100_000_000;
const MODEL_MAX_BYTES = 200_000_000;
const MODEL_SHA256 =
  "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
const WAV_MAX_BYTES = 32 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const WHISPER_PROMPT = "以下是普通话内容。";

let preparePromise: Promise<VoicePrepareResult> | null = null;

function modelDir(): string {
  return join(app.getPath("userData"), "voice");
}

function modelPath(): string {
  return join(modelDir(), MODEL_FILE);
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveWhisperBinary(): Promise<string | null> {
  const targetArch = process.arch === "x64" ? "x64" : "arm64";
  const candidates = [
    process.env.NEXUS_WHISPER_BIN,
    join(process.resourcesPath, "voice", "whisper-cli"),
    join(process.resourcesPath, "voice", `mac-${targetArch}`, "whisper-cli"),
    join(
      app.getAppPath(),
      "resources",
      "voice",
      `mac-${targetArch}`,
      "whisper-cli",
    ),
    join(app.getAppPath(), "resources", "voice", "whisper-cli"),
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function readModelBytes(): Promise<number> {
  try {
    const info = await stat(modelPath());
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readVoiceStatus(): Promise<VoiceStatus> {
  const [binary, modelBytes] = await Promise.all([
    resolveWhisperBinary(),
    readModelBytes(),
  ]);
  return {
    binaryAvailable: binary !== null,
    modelReady: modelBytes >= MODEL_MIN_BYTES && modelBytes <= MODEL_MAX_BYTES,
    modelBytes,
  };
}

function sendProgress(
  getWindow: () => BrowserWindow | null,
  progress: VoiceModelProgress,
): void {
  const window = getWindow();
  if (!window || window.isDestroyed()) return;
  window.webContents.send(VOICE_CHANNELS.progress, progress);
}

async function prepareModelWith(
  getWindow: () => BrowserWindow | null,
): Promise<VoicePrepareResult> {
  const status = await readVoiceStatus();
  if (!status.binaryAvailable) {
    return {
      ok: false,
      reason: "本地语音引擎未安装，请先安装 whisper.cpp 后重试",
    };
  }
  if (status.modelReady) return { ok: true };

  await mkdir(modelDir(), { recursive: true });
  const destination = modelPath();
  const partial = `${destination}.part`;
  let lastProgressAt = 0;
  let lastError: unknown = null;

  for (const url of MODEL_URLS) {
    try {
      await rm(partial, { force: true });
      await downloadHttpToFile({
        url,
        destPath: partial,
        minBytes: MODEL_MIN_BYTES,
        onProgress: ({ transferred, total }) => {
          const now = Date.now();
          if (now - lastProgressAt < 200 && transferred !== total) return;
          lastProgressAt = now;
          sendProgress(getWindow, {
            transferred,
            total,
            percent:
              total > 0
                ? Math.min(100, Math.round((transferred / total) * 100))
                : 0,
          });
        },
      });
      const downloaded = (await stat(partial)).size;
      if (downloaded < MODEL_MIN_BYTES || downloaded > MODEL_MAX_BYTES) {
        throw new Error("下载的语音模型大小异常");
      }
      if ((await sha256File(partial)) !== MODEL_SHA256) {
        throw new Error("下载的语音模型校验失败");
      }
      await rename(partial, destination);
      return { ok: true };
    } catch (error) {
      lastError = error;
      await rm(partial, { force: true }).catch(() => undefined);
    }
  }

  const detail =
    lastError instanceof Error ? lastError.message : "未知下载错误";
  return { ok: false, reason: `本地语音模型下载失败：${detail}` };
}

/** Download once; concurrent callers share the same transfer. */
export function prepareVoiceModel(
  getWindow: () => BrowserWindow | null,
): Promise<VoicePrepareResult> {
  if (!preparePromise) {
    preparePromise = prepareModelWith(getWindow).finally(() => {
      preparePromise = null;
    });
  }
  return preparePromise;
}

export function isPcm16Wav(bytes: Buffer): boolean {
  return (
    bytes.length >= 44 &&
    bytes.length <= WAV_MAX_BYTES &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

export function parseWhisperText(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^\[(?:BLANK_AUDIO|MUSIC|SOUND|NOISE)\]/i.test(line) &&
        !/^(?:load_backend|ggml_|read_audio_data|whisper_|system_info)/.test(
          line,
        ),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function transcribeVoiceWav(
  bytes: Buffer,
): Promise<VoiceTranscribeResult> {
  const status = await readVoiceStatus();
  if (!status.binaryAvailable || !status.modelReady) {
    return {
      ok: false,
      code: "not_ready",
      reason: "本地语音引擎尚未就绪",
    };
  }
  if (!isPcm16Wav(bytes)) {
    return {
      ok: false,
      code: "failed",
      reason: "录音格式无效，请重新录制",
    };
  }

  const binary = await resolveWhisperBinary();
  if (!binary) {
    return {
      ok: false,
      code: "not_ready",
      reason: "本地语音引擎尚未就绪",
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "nexus-voice-"));
  const wavPath = join(dir, "speech.wav");
  try {
    await writeFile(wavPath, bytes);
    const backendDir = join(dirname(binary), "libexec");
    const env = (await isDirectory(backendDir))
      ? { ...process.env, GGML_BACKEND_PATH: backendDir }
      : process.env;
    const { stdout } = await execFileAsync(
      binary,
      [
        "-m",
        modelPath(),
        "-f",
        wavPath,
        "-l",
        "zh",
        "-nt",
        "-np",
        "-t",
        "4",
        "--prompt",
        WHISPER_PROMPT,
      ],
      {
        timeout: TRANSCRIBE_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env,
      },
    );
    const text = parseWhisperText(stdout);
    if (!text) {
      return {
        ok: false,
        code: "no_speech",
        reason: "未检测到语音，请重试",
      };
    }
    return { ok: true, text };
  } catch {
    return {
      ok: false,
      code: "failed",
      reason: "本地语音转写失败，请重试",
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function registerVoiceIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(VOICE_CHANNELS.status, () => readVoiceStatus());
  ipcMain.handle(VOICE_CHANNELS.prepare, () => prepareVoiceModel(getWindow));
  ipcMain.handle(VOICE_CHANNELS.transcribe, (_event, raw: unknown) => {
    if (!(raw instanceof Uint8Array)) {
      return {
        ok: false,
        code: "failed",
        reason: "录音格式无效，请重新录制",
      } satisfies VoiceTranscribeResult;
    }
    return transcribeVoiceWav(Buffer.from(raw));
  });
}
