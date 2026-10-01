import { describe, expect, it } from "vitest";
import { capWasmMemory } from "./wasm-memory.js";

// A standalone WASM memory export, with minimum one page and maximum ten pages.
const binary = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 1, 1, 10, 7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0]);

describe("PDFium memory cap", () => {
  it("makes the WASM runtime itself refuse growth beyond the budget", async () => {
    const bounded = capWasmMemory(binary, 2);
    const instance = await WebAssembly.instantiate(bounded);
    const memory = instance.instance.exports.memory as WebAssembly.Memory;
    expect(memory.grow(1)).toBe(1);
    expect(() => memory.grow(1)).toThrow(RangeError);
    expect(binary[13]).toBe(10);
  });

  it("does not increase an existing smaller memory maximum", async () => {
    const instance = await WebAssembly.instantiate(capWasmMemory(binary, 20));
    const memory = instance.instance.exports.memory as WebAssembly.Memory;
    expect(memory.grow(9)).toBe(1);
    expect(() => memory.grow(1)).toThrow(RangeError);
  });

  it("rejects a cap below the module's initial memory", () => {
    expect(() => capWasmMemory(binary, 0)).toThrow();
  });

  it("fails closed for a missing or unsupported memory declaration", () => {
    expect(() => capWasmMemory(binary.slice(0, 8), 2)).toThrow();
    const shared = binary.slice();
    shared[11] = 3;
    expect(() => capWasmMemory(shared, 2)).toThrow();
  });

  it.each([1, 2, 3, 127, 128, 129, 255, 256, 257])("enforces a %i-page cap across LEB128 boundaries", async (pages) => {
    // The original module allows 1024 pages; its runtime is an independent oracle for the patched maximum.
    const original = new Uint8Array([...binary.slice(0, 8), 5, 5, 1, 1, 1, 128, 8, ...binary.slice(14)]);
    const before = original.slice();
    const instance = await WebAssembly.instantiate(capWasmMemory(original, pages));
    const memory = instance.instance.exports.memory as WebAssembly.Memory;
    expect(memory.grow(pages - 1)).toBe(1);
    expect(() => memory.grow(1)).toThrow(RangeError);
    expect(original).toEqual(before);
  });
});
