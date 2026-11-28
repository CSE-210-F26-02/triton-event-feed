import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "../src/util.js";

const BASE32_ID_PATTERN = /^[a-z2-7]+$/;

/**
 * Fake Web Crypto that fills buffers with a fixed byte sequence.
 * @param {number[]} byteSequence bytes to repeat into each buffer
 * @returns {{getRandomValues: import("vitest").Mock}}
 */
function fakeCrypto(byteSequence) {
  return {
    getRandomValues: vi.fn((buffer) => {
      buffer.forEach((_, index) => {
        buffer[index] = byteSequence[index % byteSequence.length];
      });
      return buffer;
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("randomId", () => {
  it("defaults to 16 lowercase base32 characters", () => {
    const id = randomId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(BASE32_ID_PATTERN);
  });

  it("honours a custom length", () => {
    expect(randomId(24)).toHaveLength(24);
    expect(randomId(1)).toHaveLength(1);
  });

  it("maps bytes onto the alphabet without bias (byte % 32)", () => {
    const crypto = fakeCrypto([0, 25, 26, 31, 32, 255]);
    expect(randomId(6, crypto)).toBe("az27a7");
    expect(crypto.getRandomValues).toHaveBeenCalledOnce();
  });

  it("produces different ids on successive calls", () => {
    expect(randomId(24)).not.toBe(randomId(24));
  });

  it("never falls back to Math.random", () => {
    const mathRandom = vi.spyOn(Math, "random");
    randomId(32);
    expect(mathRandom).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, "8", null])(
    "rejects invalid length %p",
    (length) => {
      expect(() => randomId(length)).toThrow(RangeError);
    },
  );

  it.each([null, {}, { getRandomValues: "not a function" }])(
    "throws when no secure generator is available (%p)",
    (cryptoImpl) => {
      expect(() => randomId(8, cryptoImpl)).toThrow(/crypto\.getRandomValues/);
    },
  );
});
