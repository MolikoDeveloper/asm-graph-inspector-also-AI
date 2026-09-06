export function makeMinimalStaticElf(): ArrayBuffer {
  const codeOffset = 0x100;
  const base = 0x400000;
  const entry = base + codeOffset;
  const code = Uint8Array.from([
    0x31, 0xff,                    // xor edi, edi
    0xb8, 0x3c, 0x00, 0x00, 0x00, // mov eax, 60
    0x0f, 0x05                     // syscall -> exit(0)
  ]);
  const bytes = new Uint8Array(codeOffset + code.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 2, true); // ET_EXEC
  view.setUint16(18, 62, true); // EM_X86_64
  view.setUint32(20, 1, true);
  view.setBigUint64(24, BigInt(entry), true);
  view.setBigUint64(32, 64n, true);
  view.setBigUint64(40, 0n, true);
  view.setUint32(48, 0, true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 1, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, 0, true);
  view.setUint16(62, 0, true);

  const ph = 64;
  view.setUint32(ph, 1, true); // PT_LOAD
  view.setUint32(ph + 4, 5, true); // PF_R | PF_X
  view.setBigUint64(ph + 8, 0n, true);
  view.setBigUint64(ph + 16, BigInt(base), true);
  view.setBigUint64(ph + 24, BigInt(base), true);
  view.setBigUint64(ph + 32, BigInt(bytes.byteLength), true);
  view.setBigUint64(ph + 40, BigInt(bytes.byteLength), true);
  view.setBigUint64(ph + 48, 0x1000n, true);
  bytes.set(code, codeOffset);
  return bytes.buffer;
}
