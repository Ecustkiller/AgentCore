/** Desktop local voice input (Whisper.cpp) contract. */

export const VOICE_CHANNELS = {
  status: "voice:status",
  prepare: "voice:prepare",
  transcribe: "voice:transcribe",
  progress: "voice:progress",
} as const;

export interface VoiceStatus {
  /** Whisper.cpp executable was found on PATH or in the app resources. */
  binaryAvailable: boolean;
  /** The multilingual 16 kHz Whisper model is installed under userData. */
  modelReady: boolean;
  modelBytes: number;
}

export type VoicePrepareResult = { ok: true } | { ok: false; reason: string };

export type VoiceTranscribeResult =
  | { ok: true; text: string }
  | {
      ok: false;
      code: "not_ready" | "no_speech" | "failed";
      reason: string;
    };

export interface VoiceModelProgress {
  transferred: number;
  total: number;
  percent: number;
}

export interface VoiceApi {
  status: () => Promise<VoiceStatus>;
  prepare: () => Promise<VoicePrepareResult>;
  transcribe: (wav: Uint8Array) => Promise<VoiceTranscribeResult>;
  onProgress: (cb: (progress: VoiceModelProgress) => void) => () => void;
}
