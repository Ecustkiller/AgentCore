import { describe, expect, it } from "vitest";
import { encodePcm16Wav } from "../voiceWav";

describe("encodePcm16Wav", () => {
  it("writes a mono 16 kHz PCM16 WAV header and samples", () => {
    const wav = encodePcm16Wav([
      new Float32Array([0, 1, -1]),
      new Float32Array([0.5]),
    ]);
    const view = new DataView(wav.buffer);
    const ascii = (start: number, end: number) =>
      new TextDecoder().decode(wav.subarray(start, end));

    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 12)).toBe("WAVE");
    expect(ascii(12, 16)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect(wav).toHaveLength(52);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0x7fff);
    expect(view.getInt16(48, true)).toBe(-0x8000);
    expect(view.getInt16(50, true)).toBe(16_383);
  });

  it("clamps samples outside PCM range", () => {
    const wav = encodePcm16Wav([new Float32Array([2, -2])]);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });
});
