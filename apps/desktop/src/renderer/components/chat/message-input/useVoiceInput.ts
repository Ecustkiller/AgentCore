import { notifyError, notifyInfo, notifySuccess } from "@/lib/toast";
import type { VoiceApi } from "@shared/voice-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { encodePcm16Wav } from "./voiceWav";

function isNative(): boolean {
  return typeof window !== "undefined" && window.__NATIVE__ === true;
}

function localVoiceApi(): VoiceApi | null {
  return typeof window !== "undefined" ? (window.voiceApi ?? null) : null;
}

export type VoiceInputState = "idle" | "recording" | "processing" | "error";

const MAX_DURATION_MS = 5 * 60 * 1000;
const LOCAL_MODEL_TOAST_ID = "voice-local-model";

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;
type CaptureMode = "browser" | "native" | "local" | null;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  return (
    (window as Window & { webkitSpeechRecognition?: SpeechRecognitionCtor })
      .webkitSpeechRecognition ??
    (window as Window & { SpeechRecognition?: SpeechRecognitionCtor })
      .SpeechRecognition ??
    null
  );
}

function mapSpeechError(error: string): string | null {
  switch (error) {
    case "not-allowed":
      return "麦克风权限被拒绝，请在系统设置中允许访问";
    case "audio-capture":
      return "未检测到麦克风设备";
    case "network":
      return "在线语音识别服务不可用，请配置本地语音模型后重试";
    case "no-speech":
      return "未检测到语音，请重试";
    case "aborted":
      return null;
    default:
      return "语音转写失败，请重试";
  }
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "麦克风权限被拒绝，请在系统设置中允许访问";
    }
    if (error.name === "NotFoundError") {
      return "未检测到麦克风设备";
    }
  }
  return "无法访问麦克风，请检查系统权限";
}

export interface UseVoiceInputOptions {
  onTranscript: (text: string) => void;
}

export function useVoiceInput({ onTranscript }: UseVoiceInputOptions) {
  const SpeechRecognitionClass = getSpeechRecognition();
  const voiceApi = localVoiceApi();
  const isSupported =
    voiceApi !== null || SpeechRecognitionClass !== null || isNative();

  const [state, setState] = useState<VoiceInputState>("idle");
  const [interimText, setInterimText] = useState("");
  const [duration, setDuration] = useState(0);

  const stateRef = useRef<VoiceInputState>("idle");
  stateRef.current = state;

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const finalPartsRef = useRef<string[]>([]);
  const intentionalStopRef = useRef(false);
  const cancelledRef = useRef(false);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const modeRef = useRef<CaptureMode>(null);
  const startingRef = useRef(false);
  const stopRef = useRef<() => void>(() => {});

  const localStreamRef = useRef<MediaStream | null>(null);
  const localContextRef = useRef<AudioContext | null>(null);
  const localSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const localProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const localMutedRef = useRef<GainNode | null>(null);
  const localChunksRef = useRef<Float32Array[]>([]);
  const localSampleRateRef = useRef(16_000);

  const clearTimers = useCallback(() => {
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, []);

  const cleanupLocalCapture = useCallback(() => {
    const processor = localProcessorRef.current;
    localProcessorRef.current = null;
    if (processor) {
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    try {
      localSourceRef.current?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      localMutedRef.current?.disconnect();
    } catch {
      /* already disconnected */
    }
    localSourceRef.current = null;
    localMutedRef.current = null;
    for (const track of localStreamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    localStreamRef.current = null;
    const context = localContextRef.current;
    localContextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }, []);

  const cleanupRecognition = useCallback(() => {
    clearTimers();
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
    }
    modeRef.current = null;
  }, [clearTimers]);

  const commitTranscript = useCallback(
    (text: string) => {
      clearTimers();
      modeRef.current = null;
      setInterimText("");
      setDuration(0);

      if (!text.trim()) {
        setState("idle");
        return;
      }

      setState("processing");
      onTranscriptRef.current(text);
      setState("idle");
    },
    [clearTimers],
  );

  const finishWithTranscript = useCallback(() => {
    const text = finalPartsRef.current.join("");
    finalPartsRef.current = [];
    commitTranscript(text);
  }, [commitTranscript]);

  const transcribeLocal = useCallback(async () => {
    const api = localVoiceApi();
    if (!api) return;
    clearTimers();
    cleanupLocalCapture();
    const wav = encodePcm16Wav(
      localChunksRef.current,
      localSampleRateRef.current,
    );
    localChunksRef.current = [];
    setDuration(0);
    setInterimText("");
    setState("processing");

    try {
      const result = await api.transcribe(wav);
      if (cancelledRef.current) return;
      if (!result.ok) {
        notifyError(result.reason);
        setState("idle");
        return;
      }
      commitTranscript(result.text);
    } catch {
      if (!cancelledRef.current) {
        notifyError("本地语音转写失败，请重试");
        setState("idle");
      }
    }
  }, [cleanupLocalCapture, clearTimers, commitTranscript]);

  const beginLocalCapture = useCallback(async (): Promise<
    "started" | "needs_prepare" | "missing_binary" | "failed"
  > => {
    const api = localVoiceApi();
    if (!api) return "missing_binary";
    const status = await api.status();
    if (!status.binaryAvailable) {
      notifyError(
        "本地语音引擎未安装，请在终端运行 brew install whisper-cpp 后重启 Nexus",
      );
      return "missing_binary";
    }
    if (!status.modelReady) {
      notifyInfo("首次使用本地语音需下载模型", {
        description: "约 142 MB，只需下载一次，之后录音仅在本机转写",
        duration: Number.POSITIVE_INFINITY,
        id: LOCAL_MODEL_TOAST_ID,
        action: {
          label: "下载并启用",
          onClick: () => {
            if (startingRef.current) return;
            startingRef.current = true;
            notifyInfo("正在下载本地语音模型", {
              description: "准备中…",
              duration: Number.POSITIVE_INFINITY,
              id: LOCAL_MODEL_TOAST_ID,
            });
            void api
              .prepare()
              .then(async (result) => {
                if (!result.ok) {
                  notifyError(result.reason, undefined, {
                    id: LOCAL_MODEL_TOAST_ID,
                  });
                  return;
                }
                notifySuccess("本地语音模型已就绪", {
                  description: "后续语音输入可离线使用",
                  id: LOCAL_MODEL_TOAST_ID,
                });
                await beginLocalCapture();
              })
              .finally(() => {
                startingRef.current = false;
              });
          },
        },
      });
      return "needs_prepare";
    }

    cancelledRef.current = false;
    intentionalStopRef.current = false;
    localChunksRef.current = [];
    setInterimText("");
    setDuration(0);
    startTimeRef.current = Date.now();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const context = new AudioContext({ sampleRate: 16_000 });
      if (context.state === "suspended") await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const muted = context.createGain();
      muted.gain.value = 0;
      processor.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0);
        localChunksRef.current.push(new Float32Array(channel));
      };
      source.connect(processor);
      processor.connect(muted);
      muted.connect(context.destination);

      localStreamRef.current = stream;
      localContextRef.current = context;
      localSourceRef.current = source;
      localProcessorRef.current = processor;
      localMutedRef.current = muted;
      localSampleRateRef.current = context.sampleRate;
      modeRef.current = "local";
      setState("recording");

      durationTimerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
      maxTimerRef.current = setTimeout(() => {
        void transcribeLocal();
      }, MAX_DURATION_MS);
      return "started";
    } catch (error) {
      cleanupLocalCapture();
      notifyError(microphoneError(error));
      setState("idle");
      return "failed";
    }
  }, [cleanupLocalCapture, transcribeLocal]);

  const startNative = useCallback(async () => {
    const { SpeechRecognition } = await import(
      "@capgo/capacitor-speech-recognition"
    );
    const perm = await SpeechRecognition.requestPermissions();
    if (perm.speechRecognition !== "granted") {
      notifyError("麦克风权限被拒绝，请在系统设置中允许访问");
      setState("idle");
      return;
    }
    const { available } = await SpeechRecognition.available();
    if (!available) {
      notifyError("此设备不支持语音识别");
      setState("idle");
      return;
    }
    const language = navigator.language || "zh-CN";
    await SpeechRecognition.removeAllListeners();
    await SpeechRecognition.addListener("partialResults", (event) => {
      const text = event.matches?.[0] ?? "";
      setInterimText(text);
      finalPartsRef.current = text ? [text] : [];
    });
    await SpeechRecognition.addListener("listeningState", (event) => {
      if (event.status === "stopped" && !intentionalStopRef.current) {
        finishWithTranscript();
      }
    });
    await SpeechRecognition.start({ language, partialResults: true });
    modeRef.current = "native";
    setState("recording");
    durationTimerRef.current = setInterval(() => {
      setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    maxTimerRef.current = setTimeout(() => {
      stopRef.current();
    }, MAX_DURATION_MS);
  }, [finishWithTranscript]);

  const startBrowser = useCallback(() => {
    if (!SpeechRecognitionClass) return false;
    modeRef.current = "browser";
    cancelledRef.current = false;
    intentionalStopRef.current = false;
    finalPartsRef.current = [];
    setInterimText("");
    setDuration(0);
    startTimeRef.current = Date.now();

    const rec = new SpeechRecognitionClass();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language;

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finalPartsRef.current.push(transcript);
        } else {
          interim += transcript;
        }
      }
      setInterimText(interim);
    };

    rec.onerror = (event) => {
      if (cancelledRef.current) return;
      const message = mapSpeechError(event.error);
      cleanupRecognition();
      finalPartsRef.current = [];
      setInterimText("");
      setDuration(0);
      setState("idle");
      if (message) notifyError(message);
    };

    rec.onend = () => {
      if (cancelledRef.current) return;
      if (intentionalStopRef.current) {
        recognitionRef.current = null;
        finishWithTranscript();
        return;
      }
      if (recognitionRef.current && !intentionalStopRef.current) {
        try {
          rec.start();
        } catch {
          recognitionRef.current = null;
          finishWithTranscript();
        }
      }
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setState("recording");
      durationTimerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
      maxTimerRef.current = setTimeout(() => {
        stopRef.current();
      }, MAX_DURATION_MS);
      return true;
    } catch {
      cleanupRecognition();
      notifyError("无法启动语音识别，请重试");
      setState("idle");
      return false;
    }
  }, [SpeechRecognitionClass, cleanupRecognition, finishWithTranscript]);

  const stop = useCallback(() => {
    if (stateRef.current !== "recording") return;
    intentionalStopRef.current = true;
    clearTimers();
    if (modeRef.current === "local") {
      void transcribeLocal();
      return;
    }
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        finishWithTranscript();
      }
    } else if (modeRef.current === "native" && isNative()) {
      void import("@capgo/capacitor-speech-recognition").then(
        ({ SpeechRecognition }) => {
          void SpeechRecognition.stop().catch(() => {});
          finishWithTranscript();
        },
      );
    } else {
      finishWithTranscript();
    }
  }, [clearTimers, finishWithTranscript, transcribeLocal]);

  stopRef.current = stop;

  const cancel = useCallback(() => {
    if (stateRef.current !== "recording") return;
    cancelledRef.current = true;
    intentionalStopRef.current = true;
    finalPartsRef.current = [];
    localChunksRef.current = [];
    setInterimText("");
    setDuration(0);
    clearTimers();
    if (modeRef.current === "local") cleanupLocalCapture();
    else cleanupRecognition();
    if (modeRef.current === "native" && isNative()) {
      void import("@capgo/capacitor-speech-recognition").then(
        ({ SpeechRecognition }) => {
          void SpeechRecognition.stop().catch(() => {});
        },
      );
    }
    modeRef.current = null;
    setState("idle");
  }, [cleanupLocalCapture, cleanupRecognition, clearTimers]);

  const start = useCallback(() => {
    if (stateRef.current !== "idle" || startingRef.current) return;
    startingRef.current = true;
    const resetStarting = () => {
      startingRef.current = false;
    };

    if (voiceApi) {
      void beginLocalCapture()
        .catch(() => {
          notifyError("无法启动本地语音识别，请重试");
          setState("idle");
        })
        .finally(resetStarting);
      return;
    }

    if (!SpeechRecognitionClass) {
      if (!isNative()) {
        resetStarting();
        return;
      }
      cancelledRef.current = false;
      intentionalStopRef.current = false;
      finalPartsRef.current = [];
      setInterimText("");
      setDuration(0);
      startTimeRef.current = Date.now();
      setState("recording");
      void startNative()
        .catch(() => {
          clearTimers();
          notifyError("无法启动语音识别，请重试");
          setState("idle");
        })
        .finally(resetStarting);
      return;
    }

    startBrowser();
    resetStarting();
  }, [
    SpeechRecognitionClass,
    beginLocalCapture,
    clearTimers,
    startBrowser,
    startNative,
    voiceApi,
  ]);

  const toggle = useCallback(() => {
    if (stateRef.current === "idle") {
      start();
    } else if (stateRef.current === "recording") {
      stop();
    }
  }, [start, stop]);

  useEffect(() => {
    return (
      voiceApi?.onProgress((progress) => {
        notifyInfo("正在下载本地语音模型", {
          description: `${progress.percent}%`,
          duration: Number.POSITIVE_INFINITY,
          id: LOCAL_MODEL_TOAST_ID,
        });
      }) ?? undefined
    );
  }, [voiceApi]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      intentionalStopRef.current = true;
      cleanupRecognition();
      cleanupLocalCapture();
    };
  }, [cleanupLocalCapture, cleanupRecognition]);

  return {
    isSupported,
    state,
    interimText,
    duration,
    start,
    stop,
    cancel,
    toggle,
    isRecording: state === "recording",
    isProcessing: state === "processing",
  };
}
