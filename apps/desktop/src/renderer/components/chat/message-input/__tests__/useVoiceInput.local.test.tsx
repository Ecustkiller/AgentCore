// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifySuccess: vi.fn(),
}));

import type { VoiceApi } from "@shared/voice-contract";
import { useVoiceInput } from "../useVoiceInput";

class FakeProcessor {
  onaudioprocess:
    | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void)
    | null = null;
  connect() {}
  disconnect() {}
}

class FakeAudioContext {
  state = "running";
  sampleRate = 16_000;
  destination = {};
  async resume() {}
  async close() {}
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createScriptProcessor() {
    return new FakeProcessor();
  }
  createGain() {
    return { gain: { value: 0 }, connect() {}, disconnect() {} };
  }
}

function api(over: Partial<VoiceApi> = {}): VoiceApi {
  return {
    status: vi.fn(async () => ({
      binaryAvailable: true,
      modelReady: true,
      modelBytes: 147_951_465,
    })),
    prepare: vi.fn(async () => ({ ok: true as const })),
    transcribe: vi.fn(async () => ({ ok: true as const, text: "基金分析" })),
    onProgress: vi.fn(() => () => {}),
    ...over,
  };
}

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: vi.fn() }],
      })),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.voiceApi = undefined;
});

describe("useVoiceInput local engine", () => {
  it("records PCM locally and inserts the offline transcript", async () => {
    const voiceApi = api();
    window.voiceApi = voiceApi;
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscript }));

    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.state).toBe("recording"));

    await act(async () => {
      result.current.stop();
    });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("基金分析"));
    expect(voiceApi.transcribe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(voiceApi.transcribe).mock.calls[0]?.[0]).toBeInstanceOf(
      Uint8Array,
    );
    expect(result.current.state).toBe("idle");
  });

  it("does not open the microphone until the offline model is downloaded", async () => {
    const voiceApi = api({
      status: vi.fn(async () => ({
        binaryAvailable: true,
        modelReady: false,
        modelBytes: 0,
      })),
    });
    window.voiceApi = voiceApi;
    const { result } = renderHook(() =>
      useVoiceInput({ onTranscript: vi.fn() }),
    );

    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(voiceApi.status).toHaveBeenCalled());
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });
});
