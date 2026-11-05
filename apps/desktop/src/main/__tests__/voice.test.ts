import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/nexus-test" },
  ipcMain: { handle: vi.fn() },
}));
vi.mock("../installer-download", () => ({
  downloadHttpToFile: vi.fn(),
}));

import { isPcm16Wav, parseWhisperText } from "../voice";

describe("voice main helpers", () => {
  it("accepts RIFF/WAVE PCM files within the upload cap", () => {
    const wav = Buffer.alloc(44);
    wav.write("RIFF", 0, "ascii");
    wav.write("WAVE", 8, "ascii");
    expect(isPcm16Wav(wav)).toBe(true);
    expect(isPcm16Wav(Buffer.from("not a wav"))).toBe(false);
  });

  it("removes whisper runtime noise and blank-audio markers", () => {
    expect(
      parseWhisperText(
        [
          "load_backend: loaded Metal",
          "read_audio_data: reading audio",
          "今天天气怎么样?",
          "[BLANK_AUDIO]",
          "帮我分析基金。",
        ].join("\n"),
      ),
    ).toBe("今天天气怎么样? 帮我分析基金。");
  });
});
