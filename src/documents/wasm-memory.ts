/** Encode unsigned WASM section sizes and memory limits as LEB128. */
function unsigned(value: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value > 0);
  return new Uint8Array(bytes);
}

/** Cap PDFium's declared linear memory. V8 worker heap limits do not cover WASM memory. */
export function capWasmMemory(binary: Uint8Array, maximumPages: number): ArrayBuffer {
  if (!Number.isSafeInteger(maximumPages) || maximumPages < 1 || maximumPages > 65536
    || binary.length < 8 || ![0, 97, 115, 109, 1, 0, 0, 0].every((byte, index) => binary[index] === byte)) {
    throw new Error("Invalid PDFium WASM memory configuration");
  }
  let offset = 8;
  /** Read an unsigned 32-bit LEB field, failing closed on unsupported declarations. */
  function readUnsigned(): number {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      if (offset >= binary.length) {
        break;
      }
      const byte = binary[offset++];
      if (shift === 28 && (byte & 0xf0) !== 0) {
        break;
      }
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        return value;
      }
    }
    throw new Error("Invalid PDFium WASM declaration");
  }
  while (offset < binary.length) {
    const start = offset;
    const section = binary[offset++];
    const size = readUnsigned();
    const end = offset + size;
    if (end > binary.length) {
      throw new Error("Invalid PDFium WASM section");
    }
    if (section !== 5) {
      offset = end;
      continue;
    }
    const count = readUnsigned();
    const flags = readUnsigned();
    const minimum = readUnsigned();
    let maximum = maximumPages;
    if (flags === 1) {
      maximum = Math.min(maximum, readUnsigned());
    }
    if (count !== 1 || (flags !== 0 && flags !== 1) || minimum > maximum || offset !== end) {
      throw new Error("Unsupported PDFium WASM memory declaration");
    }
    const memory = new Uint8Array([1, 1, ...unsigned(minimum), ...unsigned(maximum)]);
    const header = new Uint8Array([5, ...unsigned(memory.length)]);
    const output = new Uint8Array(start + header.length + memory.length + binary.length - end);
    output.set(binary.subarray(0, start));
    output.set(header, start);
    output.set(memory, start + header.length);
    output.set(binary.subarray(end), start + header.length + memory.length);
    const module = new WebAssembly.Module(output);
    if (WebAssembly.Module.imports(module).some((entry) => entry.kind === "memory")) {
      throw new Error("Imported PDFium WASM memory is unsupported");
    }
    return output.buffer;
  }
  throw new Error("PDFium WASM memory declaration not found");
}
