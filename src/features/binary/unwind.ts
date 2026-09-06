import type {
  ElfCfiRegisterRule,
  ElfCfiRow,
  ElfCfiRule,
  ElfSection,
  ElfUnwindCie,
  ElfUnwindFde,
  ElfUnwindModel,
  ElfUnwindSource
} from './model';

const DW_EH_PE = Object.freeze({
  absptr: 0x00,
  uleb128: 0x01,
  udata2: 0x02,
  udata4: 0x03,
  udata8: 0x04,
  sleb128: 0x09,
  sdata2: 0x0a,
  sdata4: 0x0b,
  sdata8: 0x0c,
  pcrel: 0x10,
  textrel: 0x20,
  datarel: 0x30,
  funcrel: 0x40,
  aligned: 0x50,
  omit: 0xff
});

const DW_CFA = Object.freeze({
  nop: 0x00,
  setLoc: 0x01,
  advanceLoc1: 0x02,
  advanceLoc2: 0x03,
  advanceLoc4: 0x04,
  offsetExtended: 0x05,
  restoreExtended: 0x06,
  undefined: 0x07,
  sameValue: 0x08,
  register: 0x09,
  rememberState: 0x0a,
  restoreState: 0x0b,
  defCfa: 0x0c,
  defCfaRegister: 0x0d,
  defCfaOffset: 0x0e,
  defCfaExpression: 0x0f,
  expression: 0x10,
  offsetExtendedSf: 0x11,
  defCfaSf: 0x12,
  defCfaOffsetSf: 0x13,
  valOffset: 0x14,
  valOffsetSf: 0x15,
  valExpression: 0x16,
  gnuArgsSize: 0x2e,
  gnuNegativeOffsetExtended: 0x2f
});

interface CfiState {
  cfa: ElfCfiRule | null;
  registerRules: Map<number, ElfCfiRule>;
  argsSize: number | null;
}

interface CieRecord extends ElfUnwindCie {
  initialState: CfiState;
}

class Reader {
  constructor(
    private readonly view: DataView,
    public pos: number,
    public readonly end: number,
    public readonly littleEndian: boolean
  ) {}

  ensure(size: number): void {
    if (this.pos + size > this.end) throw new Error('truncated DWARF frame data');
  }

  u8(): number { this.ensure(1); return this.view.getUint8(this.pos++); }
  i8(): number { this.ensure(1); return this.view.getInt8(this.pos++); }
  u16(): number { this.ensure(2); const value = this.view.getUint16(this.pos, this.littleEndian); this.pos += 2; return value; }
  i16(): number { this.ensure(2); const value = this.view.getInt16(this.pos, this.littleEndian); this.pos += 2; return value; }
  u32(): number { this.ensure(4); const value = this.view.getUint32(this.pos, this.littleEndian); this.pos += 4; return value; }
  i32(): number { this.ensure(4); const value = this.view.getInt32(this.pos, this.littleEndian); this.pos += 4; return value; }

  u64BigInt(): bigint {
    this.ensure(8);
    const value = this.view.getBigUint64(this.pos, this.littleEndian);
    this.pos += 8;
    return value;
  }

  u64(): number {
    const value = Number(this.u64BigInt());
    if (!Number.isSafeInteger(value)) throw new Error('64-bit DWARF value exceeds browser-safe integer range');
    return value;
  }

  i64(): number {
    this.ensure(8);
    const value = Number(this.view.getBigInt64(this.pos, this.littleEndian));
    this.pos += 8;
    if (!Number.isSafeInteger(value)) throw new Error('signed 64-bit DWARF value exceeds browser-safe integer range');
    return value;
  }

  uleb(): number {
    let result = 0;
    let shift = 0;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
    throw new Error('ULEB128 exceeds supported width');
  }

  sleb(): number {
    let result = 0;
    let shift = 0;
    let byte = 0;
    for (let index = 0; index < 10; index += 1) {
      byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    if (shift < 53 && (byte & 0x40) !== 0) result -= 2 ** shift;
    return result;
  }

  cstr(): string {
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset, this.view.byteLength);
    const start = this.pos;
    while (this.pos < this.end && bytes[this.pos] !== 0) this.pos += 1;
    const value = new TextDecoder().decode(bytes.subarray(start, this.pos));
    if (this.pos < this.end) this.pos += 1;
    return value;
  }

  bytes(size: number): number[] {
    this.ensure(size);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, size);
    this.pos += size;
    return [...bytes];
  }
}

function sectionView(buffer: ArrayBuffer, section: ElfSection): DataView {
  if (section.offset < 0 || section.size < 0 || section.offset + section.size > buffer.byteLength) {
    throw new Error(`${section.name} is outside the ELF file range`);
  }
  return new DataView(buffer, section.offset, section.size);
}

function readerForBytes(bytes: number[]): Reader {
  const data = Uint8Array.from(bytes);
  return new Reader(new DataView(data.buffer), 0, data.length, true);
}

function readEncoded(
  reader: Reader,
  encoding: number,
  context: { sectionAddress: number; pointerSize: number; textBase?: number; dataBase?: number; functionBase?: number }
): number | null {
  if (encoding === DW_EH_PE.omit) return null;
  const application = encoding & 0x70;
  const format = encoding & 0x0f;
  const pointerSize = context.pointerSize;

  if (application === DW_EH_PE.aligned) {
    const absolute = context.sectionAddress + reader.pos;
    const aligned = Math.ceil(absolute / pointerSize) * pointerSize;
    reader.pos += aligned - absolute;
  }

  const fieldAddress = context.sectionAddress + reader.pos;
  let raw: number;
  switch (format) {
    case DW_EH_PE.absptr: raw = pointerSize === 8 ? reader.u64() : reader.u32(); break;
    case DW_EH_PE.uleb128: raw = reader.uleb(); break;
    case DW_EH_PE.udata2: raw = reader.u16(); break;
    case DW_EH_PE.udata4: raw = reader.u32(); break;
    case DW_EH_PE.udata8: raw = reader.u64(); break;
    case DW_EH_PE.sleb128: raw = reader.sleb(); break;
    case DW_EH_PE.sdata2: raw = reader.i16(); break;
    case DW_EH_PE.sdata4: raw = reader.i32(); break;
    case DW_EH_PE.sdata8: raw = reader.i64(); break;
    default: throw new Error(`unsupported DW_EH_PE format 0x${format.toString(16)}`);
  }

  if (application === DW_EH_PE.pcrel) return fieldAddress + raw;
  if (application === DW_EH_PE.textrel && context.textBase !== undefined) return context.textBase + raw;
  if (application === DW_EH_PE.datarel && context.dataBase !== undefined) return context.dataBase + raw;
  if (application === DW_EH_PE.funcrel && context.functionBase !== undefined) return context.functionBase + raw;
  return raw;
}

function cloneRule(rule: ElfCfiRule | null): ElfCfiRule | null {
  if (!rule) return null;
  if ('expression' in rule) return { ...rule, expression: [...rule.expression] } as ElfCfiRule;
  return { ...rule } as ElfCfiRule;
}

function cloneState(state: CfiState): CfiState {
  return {
    cfa: cloneRule(state.cfa),
    registerRules: new Map([...state.registerRules].map(([register, rule]) => [register, cloneRule(rule)!])),
    argsSize: state.argsSize
  };
}

function ruleKey(rule: ElfCfiRule | null): string {
  if (!rule) return 'same';
  if (rule.kind === 'cfa-register-offset') return `cfa:${rule.register ?? 'none'}:${rule.offset}`;
  if (rule.kind === 'offset' || rule.kind === 'val-offset') return `${rule.kind}:${rule.offset}`;
  if (rule.kind === 'register') return `register:${rule.register}`;
  if ('expression' in rule) return `${rule.kind}:${rule.expression.join(',')}`;
  return rule.kind;
}

function stateKey(state: CfiState): string {
  const registers = [...state.registerRules].sort((a, b) => a[0] - b[0]).map(([register, rule]) => `${register}=${ruleKey(rule)}`).join(';');
  return `${ruleKey(state.cfa)}|${registers}|args:${state.argsSize ?? ''}`;
}

function stateToRow(state: CfiState, startAddress: number, endAddress: number, returnRegister: number | null): ElfCfiRow {
  const registerRules: ElfCfiRegisterRule[] = [...state.registerRules]
    .sort((a, b) => a[0] - b[0])
    .map(([register, rule]) => ({ register, rule: cloneRule(rule)! }));
  return {
    startAddress,
    endAddress,
    cfa: cloneRule(state.cfa),
    registerRules,
    returnAddressRegister: returnRegister,
    returnAddressRule: returnRegister === null ? null : cloneRule(state.registerRules.get(returnRegister) ?? null),
    argsSize: state.argsSize
  };
}

function decodeCfiProgram(
  bytes: number[],
  cie: Pick<ElfUnwindCie, 'addressSize' | 'codeAlignment' | 'dataAlignment' | 'returnRegister'>,
  options: { startAddress?: number; endAddress?: number | null; initialState?: CfiState; restoreState?: CfiState; emitRows?: boolean } = {}
): { finalState: CfiState; rows: ElfCfiRow[]; diagnostics: string[]; parseComplete: boolean } {
  const reader = readerForBytes(bytes);
  const rows: ElfCfiRow[] = [];
  const diagnostics: string[] = [];
  const remember: CfiState[] = [];
  const initial = options.initialState ?? { cfa: null, registerRules: new Map(), argsSize: null };
  const restoreBase = options.restoreState ?? initial;
  let state = cloneState(initial);
  let pc = options.startAddress ?? 0;
  let parseComplete = true;

  const emitUntil = (nextPc: number) => {
    if (options.emitRows === false || nextPc <= pc) return;
    const end = options.endAddress === null || options.endAddress === undefined ? nextPc : Math.min(nextPc, options.endAddress);
    if (end <= pc) return;
    rows.push(stateToRow(state, pc, end, cie.returnRegister));
  };
  const advance = (delta: number) => {
    const next = pc + delta * cie.codeAlignment;
    emitUntil(next);
    pc = next;
  };
  const restoreRegister = (register: number) => {
    const rule = restoreBase.registerRules.get(register);
    if (rule) state.registerRules.set(register, cloneRule(rule)!);
    else state.registerRules.delete(register);
  };
  const readExpression = () => reader.bytes(reader.uleb());

  try {
    while (reader.pos < reader.end) {
      const offset = reader.pos;
      const opcode = reader.u8();
      const primary = opcode & 0xc0;
      const operand = opcode & 0x3f;
      if (primary === 0x40) {
        advance(operand);
        continue;
      }
      if (primary === 0x80) {
        state.registerRules.set(operand, { kind: 'offset', offset: reader.uleb() * cie.dataAlignment });
        continue;
      }
      if (primary === 0xc0) {
        restoreRegister(operand);
        continue;
      }
      switch (opcode) {
        case DW_CFA.nop: break;
        case DW_CFA.setLoc: {
          const next = cie.addressSize === 8 ? reader.u64() : reader.u32();
          emitUntil(next);
          pc = next;
          break;
        }
        case DW_CFA.advanceLoc1: advance(reader.u8()); break;
        case DW_CFA.advanceLoc2: advance(reader.u16()); break;
        case DW_CFA.advanceLoc4: advance(reader.u32()); break;
        case DW_CFA.offsetExtended: {
          const register = reader.uleb();
          state.registerRules.set(register, { kind: 'offset', offset: reader.uleb() * cie.dataAlignment });
          break;
        }
        case DW_CFA.restoreExtended: restoreRegister(reader.uleb()); break;
        case DW_CFA.undefined: state.registerRules.set(reader.uleb(), { kind: 'undefined' }); break;
        case DW_CFA.sameValue: state.registerRules.set(reader.uleb(), { kind: 'same-value' }); break;
        case DW_CFA.register: {
          const register = reader.uleb();
          state.registerRules.set(register, { kind: 'register', register: reader.uleb() });
          break;
        }
        case DW_CFA.rememberState: remember.push(cloneState(state)); break;
        case DW_CFA.restoreState:
          if (remember.length) state = remember.pop()!;
          else diagnostics.push(`CFI +0x${offset.toString(16)}: restore_state without remember_state`);
          break;
        case DW_CFA.defCfa: state.cfa = { kind: 'cfa-register-offset', register: reader.uleb(), offset: reader.uleb() }; break;
        case DW_CFA.defCfaRegister: {
          const register = reader.uleb();
          state.cfa = state.cfa?.kind === 'cfa-register-offset'
            ? { ...state.cfa, register }
            : { kind: 'cfa-register-offset', register, offset: 0 };
          break;
        }
        case DW_CFA.defCfaOffset: {
          const offsetValue = reader.uleb();
          state.cfa = state.cfa?.kind === 'cfa-register-offset'
            ? { ...state.cfa, offset: offsetValue }
            : { kind: 'cfa-register-offset', register: null, offset: offsetValue };
          break;
        }
        case DW_CFA.defCfaExpression: state.cfa = { kind: 'cfa-expression', expression: readExpression() }; break;
        case DW_CFA.expression: state.registerRules.set(reader.uleb(), { kind: 'expression', expression: readExpression() }); break;
        case DW_CFA.offsetExtendedSf: {
          const register = reader.uleb();
          state.registerRules.set(register, { kind: 'offset', offset: reader.sleb() * cie.dataAlignment });
          break;
        }
        case DW_CFA.defCfaSf: state.cfa = { kind: 'cfa-register-offset', register: reader.uleb(), offset: reader.sleb() * cie.dataAlignment }; break;
        case DW_CFA.defCfaOffsetSf: {
          const offsetValue = reader.sleb() * cie.dataAlignment;
          state.cfa = state.cfa?.kind === 'cfa-register-offset'
            ? { ...state.cfa, offset: offsetValue }
            : { kind: 'cfa-register-offset', register: null, offset: offsetValue };
          break;
        }
        case DW_CFA.valOffset: {
          const register = reader.uleb();
          state.registerRules.set(register, { kind: 'val-offset', offset: reader.uleb() * cie.dataAlignment });
          break;
        }
        case DW_CFA.valOffsetSf: {
          const register = reader.uleb();
          state.registerRules.set(register, { kind: 'val-offset', offset: reader.sleb() * cie.dataAlignment });
          break;
        }
        case DW_CFA.valExpression: state.registerRules.set(reader.uleb(), { kind: 'val-expression', expression: readExpression() }); break;
        case DW_CFA.gnuArgsSize: state.argsSize = reader.uleb(); break;
        case DW_CFA.gnuNegativeOffsetExtended: {
          const register = reader.uleb();
          state.registerRules.set(register, { kind: 'offset', offset: -reader.uleb() * cie.dataAlignment });
          break;
        }
        default:
          diagnostics.push(`CFI +0x${offset.toString(16)}: unsupported opcode 0x${opcode.toString(16)}; remaining program skipped`);
          parseComplete = false;
          reader.pos = reader.end;
          break;
      }
    }
  } catch (error) {
    diagnostics.push(`CFI +0x${reader.pos.toString(16)}: ${error instanceof Error ? error.message : String(error)}`);
    parseComplete = false;
  }

  if (options.emitRows !== false && options.endAddress !== null && options.endAddress !== undefined && pc < options.endAddress) emitUntil(options.endAddress);
  const compact: ElfCfiRow[] = [];
  for (const row of rows) {
    const previous = compact.at(-1);
    const rowState: CfiState = { cfa: row.cfa, registerRules: new Map(row.registerRules.map((item) => [item.register, item.rule])), argsSize: row.argsSize };
    if (previous && previous.endAddress === row.startAddress) {
      const previousState: CfiState = { cfa: previous.cfa, registerRules: new Map(previous.registerRules.map((item) => [item.register, item.rule])), argsSize: previous.argsSize };
      if (stateKey(previousState) === stateKey(rowState)) {
        previous.endAddress = row.endAddress;
        continue;
      }
    }
    compact.push(row);
  }
  return { finalState: cloneState(state), rows: compact, diagnostics, parseComplete };
}

function parseCieCommon(reader: Reader, entryAddress: number, entryOffset: number, entryEnd: number, section: ElfSection, source: ElfUnwindSource): CieRecord {
  const version = reader.u8();
  const augmentation = reader.cstr();
  let addressSize = 8;
  if (version >= 4) { addressSize = reader.u8(); reader.u8(); }
  const codeAlignment = reader.uleb();
  const dataAlignment = reader.sleb();
  const returnRegister = version === 1 ? reader.u8() : reader.uleb();
  const cie: CieRecord = {
    id: `${section.index}:cie:${entryAddress.toString(16)}`,
    source,
    address: entryAddress,
    sectionIndex: section.index,
    sectionName: section.name,
    version,
    augmentation,
    addressSize,
    codeAlignment,
    dataAlignment,
    returnRegister,
    fdeEncoding: DW_EH_PE.absptr,
    lsdaEncoding: DW_EH_PE.omit,
    instructions: [],
    initialCfi: null,
    parseComplete: true,
    initialState: { cfa: null, registerRules: new Map(), argsSize: null }
  };
  void entryOffset;
  void entryEnd;
  return cie;
}

function parseEhFrame(buffer: ArrayBuffer, section: ElfSection, sections: ElfSection[]): { cies: CieRecord[]; fdes: ElfUnwindFde[]; errors: string[]; cfiDiagnostics: string[] } {
  const view = sectionView(buffer, section);
  const reader = new Reader(view, 0, view.byteLength, true);
  const fdes: ElfUnwindFde[] = [];
  const errors: string[] = [];
  const cfiDiagnostics: string[] = [];
  const ciesByAddress = new Map<number, CieRecord>();
  const cies: CieRecord[] = [];
  const textBase = sections.find((candidate) => candidate.name === '.text')?.address;
  const dataBase = sections.find((candidate) => candidate.name === '.data')?.address;

  while (reader.pos + 4 <= reader.end) {
    const entryOffset = reader.pos;
    const entryAddress = section.address + entryOffset;
    let length = reader.u32();
    let offsetSize = 4;
    if (length === 0) break;
    if (length === 0xffffffff) {
      try { length = reader.u64(); offsetSize = 8; }
      catch (error) { errors.push(`${section.name}@0x${entryAddress.toString(16)}: ${String(error)}`); break; }
    }
    const bodyStart = reader.pos;
    const entryEnd = bodyStart + length;
    if (length < offsetSize || entryEnd > reader.end) {
      errors.push(`${section.name}@0x${entryAddress.toString(16)}: invalid/truncated entry length`);
      break;
    }

    try {
      const idFieldOffset = reader.pos;
      const idFieldAddress = section.address + idFieldOffset;
      const ciePointerRaw = offsetSize === 8 ? reader.u64BigInt() : BigInt(reader.u32());
      if (ciePointerRaw === 0n) {
        const cie = parseCieCommon(reader, entryAddress, entryOffset, entryEnd, section, 'eh_frame');
        if (cie.augmentation.startsWith('z')) {
          const augmentationLength = reader.uleb();
          const augmentationEnd = Math.min(entryEnd, reader.pos + augmentationLength);
          for (const character of cie.augmentation.slice(1)) {
            if (reader.pos >= augmentationEnd) break;
            if (character === 'L') cie.lsdaEncoding = reader.u8();
            else if (character === 'R') cie.fdeEncoding = reader.u8();
            else if (character === 'P') {
              const personalityEncoding = reader.u8();
              readEncoded(reader, personalityEncoding, { sectionAddress: section.address, pointerSize: cie.addressSize, textBase, dataBase });
            } else if (character !== 'S') {
              cie.parseComplete = false;
              reader.pos = augmentationEnd;
              break;
            }
          }
          reader.pos = augmentationEnd;
        }
        cie.instructions = reader.bytes(Math.max(0, entryEnd - reader.pos));
        const initial = decodeCfiProgram(cie.instructions, cie, { emitRows: false });
        cie.initialState = initial.finalState;
        cie.initialCfi = stateToRow(initial.finalState, 0, 0, cie.returnRegister);
        cie.parseComplete = cie.parseComplete && initial.parseComplete;
        cfiDiagnostics.push(...initial.diagnostics.map((diagnostic) => `${section.name} CIE 0x${entryAddress.toString(16)}: ${diagnostic}`));
        ciesByAddress.set(entryAddress, cie);
        cies.push(cie);
      } else {
        const ciePointer = Number(ciePointerRaw);
        if (!Number.isSafeInteger(ciePointer)) throw new Error('64-bit CIE pointer exceeds browser-safe integer range');
        const cieAddress = idFieldAddress - ciePointer;
        const cie = ciesByAddress.get(cieAddress);
        if (!cie) throw new Error(`FDE references unknown CIE 0x${cieAddress.toString(16)}`);
        const startAddress = readEncoded(reader, cie.fdeEncoding, { sectionAddress: section.address, pointerSize: cie.addressSize, textBase, dataBase });
        const rangeEncoding = cie.fdeEncoding & 0x0f;
        const addressRange = readEncoded(reader, rangeEncoding, { sectionAddress: section.address, pointerSize: cie.addressSize, textBase, dataBase, functionBase: startAddress ?? undefined });
        if (cie.augmentation.startsWith('z')) {
          const augmentationLength = reader.uleb();
          reader.pos = Math.min(entryEnd, reader.pos + augmentationLength);
        }
        const instructions = reader.bytes(Math.max(0, entryEnd - reader.pos));
        if (startAddress !== null && addressRange !== null && addressRange > 0) {
          const decoded = decodeCfiProgram(instructions, cie, {
            startAddress,
            endAddress: startAddress + addressRange,
            initialState: cie.initialState,
            restoreState: cie.initialState,
            emitRows: true
          });
          const diagnostics = decoded.diagnostics.map((diagnostic) => `${section.name} FDE 0x${entryAddress.toString(16)}: ${diagnostic}`);
          cfiDiagnostics.push(...diagnostics);
          fdes.push({
            id: `${section.index}:fde:${entryAddress.toString(16)}`,
            source: 'eh_frame',
            entryAddress,
            cieAddress,
            startAddress,
            endAddress: startAddress + addressRange,
            addressRange,
            sectionIndex: section.index,
            sectionName: section.name,
            parseComplete: cie.parseComplete && decoded.parseComplete,
            instructions,
            unwindRows: decoded.rows,
            cfiDiagnostics: diagnostics
          });
        }
      }
    } catch (error) {
      errors.push(`${section.name}@0x${entryAddress.toString(16)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    reader.pos = entryEnd;
  }

  return { cies, fdes, errors, cfiDiagnostics };
}

function parseDebugFrame(buffer: ArrayBuffer, section: ElfSection): { cies: CieRecord[]; fdes: ElfUnwindFde[]; errors: string[]; cfiDiagnostics: string[] } {
  const view = sectionView(buffer, section);
  const reader = new Reader(view, 0, view.byteLength, true);
  const fdes: ElfUnwindFde[] = [];
  const errors: string[] = [];
  const cfiDiagnostics: string[] = [];
  const ciesByOffset = new Map<number, CieRecord>();
  const cies: CieRecord[] = [];

  while (reader.pos + 4 <= reader.end) {
    const entryOffset = reader.pos;
    const entryAddress = section.address + entryOffset;
    let length = reader.u32();
    let offsetSize = 4;
    if (length === 0) continue;
    if (length === 0xffffffff) { length = reader.u64(); offsetSize = 8; }
    const bodyStart = reader.pos;
    const entryEnd = bodyStart + length;
    if (length < offsetSize || entryEnd > reader.end) {
      errors.push(`${section.name}@0x${entryAddress.toString(16)}: invalid/truncated entry length`);
      break;
    }

    try {
      const cieIdRaw = offsetSize === 8 ? reader.u64BigInt() : BigInt(reader.u32());
      const isCie = offsetSize === 8 ? cieIdRaw === 0xffffffffffffffffn : cieIdRaw === 0xffffffffn;
      if (isCie) {
        const cie = parseCieCommon(reader, entryAddress, entryOffset, entryEnd, section, 'debug_frame');
        cie.instructions = reader.bytes(Math.max(0, entryEnd - reader.pos));
        const initial = decodeCfiProgram(cie.instructions, cie, { emitRows: false });
        cie.initialState = initial.finalState;
        cie.initialCfi = stateToRow(initial.finalState, 0, 0, cie.returnRegister);
        cie.parseComplete = initial.parseComplete;
        cfiDiagnostics.push(...initial.diagnostics.map((diagnostic) => `${section.name} CIE 0x${entryAddress.toString(16)}: ${diagnostic}`));
        ciesByOffset.set(entryOffset, cie);
        cies.push(cie);
      } else {
        const cieOffset = Number(cieIdRaw);
        if (!Number.isSafeInteger(cieOffset)) throw new Error('64-bit CIE offset exceeds browser-safe integer range');
        const cie = ciesByOffset.get(cieOffset);
        if (!cie) throw new Error(`FDE references unknown CIE offset 0x${cieOffset.toString(16)}`);
        const startAddress = cie.addressSize === 8 ? reader.u64() : reader.u32();
        const addressRange = cie.addressSize === 8 ? reader.u64() : reader.u32();
        const instructions = reader.bytes(Math.max(0, entryEnd - reader.pos));
        if (addressRange > 0) {
          const decoded = decodeCfiProgram(instructions, cie, {
            startAddress,
            endAddress: startAddress + addressRange,
            initialState: cie.initialState,
            restoreState: cie.initialState,
            emitRows: true
          });
          const diagnostics = decoded.diagnostics.map((diagnostic) => `${section.name} FDE 0x${entryAddress.toString(16)}: ${diagnostic}`);
          cfiDiagnostics.push(...diagnostics);
          fdes.push({
            id: `${section.index}:debug-fde:${entryAddress.toString(16)}`,
            source: 'debug_frame',
            entryAddress,
            cieAddress: cie.address,
            startAddress,
            endAddress: startAddress + addressRange,
            addressRange,
            sectionIndex: section.index,
            sectionName: section.name,
            parseComplete: decoded.parseComplete,
            instructions,
            unwindRows: decoded.rows,
            cfiDiagnostics: diagnostics
          });
        }
      }
    } catch (error) {
      errors.push(`${section.name}@0x${entryAddress.toString(16)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    reader.pos = entryEnd;
  }

  return { cies, fdes, errors, cfiDiagnostics };
}

function preferNonOverlappingFdes(fdes: ElfUnwindFde[]): ElfUnwindFde[] {
  const sourceRank = (fde: ElfUnwindFde) => fde.source === 'debug_frame' ? 0 : 1;
  const byStart = new Map<number, ElfUnwindFde>();
  for (const fde of fdes) {
    const previous = byStart.get(fde.startAddress);
    if (!previous || sourceRank(fde) < sourceRank(previous) || (sourceRank(fde) === sourceRank(previous) && fde.endAddress > previous.endAddress)) {
      byStart.set(fde.startAddress, fde);
    }
  }
  const accepted: ElfUnwindFde[] = [];
  for (const fde of [...byStart.values()].sort((a, b) => a.startAddress - b.startAddress || a.endAddress - b.endAddress)) {
    if (accepted.some((other) => fde.startAddress < other.endAddress && fde.endAddress > other.startAddress)) continue;
    accepted.push(fde);
  }
  return accepted;
}

export function dwarfRegisterName(register: number | null): string {
  if (register === null) return 'unknown';
  const names = ['rax', 'rdx', 'rcx', 'rbx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'rip'];
  return names[register] ?? `DWREG${register}`;
}

export function cfiRuleDisplay(rule: ElfCfiRule | null, isCfa = false): string {
  if (!rule) return isCfa ? 'unknown' : 'same value';
  const signed = (value: number) => `${value >= 0 ? '+' : ''}${value}`;
  switch (rule.kind) {
    case 'cfa-register-offset': return `${dwarfRegisterName(rule.register)} ${signed(rule.offset)}`;
    case 'offset': return `[CFA ${signed(rule.offset)}]`;
    case 'val-offset': return `CFA ${signed(rule.offset)}`;
    case 'same-value': return 'same value';
    case 'undefined': return 'undefined';
    case 'register': return dwarfRegisterName(rule.register);
    case 'expression': return `DWARF expression (${rule.expression.length} B)`;
    case 'val-expression': return `DWARF value expression (${rule.expression.length} B)`;
    case 'cfa-expression': return `DWARF CFA expression (${rule.expression.length} B)`;
  }
}

export function formatCfiRow(row: ElfCfiRow | null): string {
  if (!row) return 'no decoded CFI row';
  return `0x${row.startAddress.toString(16)}..0x${row.endAddress.toString(16)} · CFA = ${cfiRuleDisplay(row.cfa, true)} · ${dwarfRegisterName(row.returnAddressRegister)} ← ${cfiRuleDisplay(row.returnAddressRule)}`;
}

export function preferredFdeForPc(unwind: ElfUnwindModel, pc: number): ElfUnwindFde | null {
  const matches = unwind.fdes.filter((fde) => pc >= fde.startAddress && pc < fde.endAddress);
  return matches.sort((left, right) => (left.source === 'debug_frame' ? 0 : 1) - (right.source === 'debug_frame' ? 0 : 1) || left.addressRange - right.addressRange)[0] ?? null;
}

export function cfiRowForPc(unwind: ElfUnwindModel, pc: number): ElfCfiRow | null {
  const fde = preferredFdeForPc(unwind, pc);
  return fde?.unwindRows.find((row) => pc >= row.startAddress && pc < row.endAddress) ?? null;
}

export function cfiSummaryForPc(unwind: ElfUnwindModel, pc: number): string | null {
  const fde = preferredFdeForPc(unwind, pc);
  if (!fde) return null;
  const row = fde.unwindRows.find((candidate) => pc >= candidate.startAddress && pc < candidate.endAddress) ?? null;
  return row ? `${fde.source} · ${formatCfiRow(row)}` : `${fde.source} FDE 0x${fde.startAddress.toString(16)}..0x${fde.endAddress.toString(16)} · no decoded row`;
}

export function parseElfUnwind(buffer: ArrayBuffer, sections: ElfSection[]): ElfUnwindModel {
  const ehFrame = sections.find((section) => section.name === '.eh_frame' && section.size > 0);
  const debugFrame = sections.find((section) => section.name === '.debug_frame' && section.size > 0);
  if (!ehFrame && !debugFrame) return { available: false, cies: [], fdes: [], errors: [], cfiDiagnostics: [], cfiRowCount: 0 };

  const cies: CieRecord[] = [];
  const fdes: ElfUnwindFde[] = [];
  const errors: string[] = [];
  const cfiDiagnostics: string[] = [];
  if (ehFrame) {
    const parsed = parseEhFrame(buffer, ehFrame, sections);
    cies.push(...parsed.cies);
    fdes.push(...parsed.fdes);
    errors.push(...parsed.errors);
    cfiDiagnostics.push(...parsed.cfiDiagnostics);
  }
  if (debugFrame) {
    const parsed = parseDebugFrame(buffer, debugFrame);
    cies.push(...parsed.cies);
    fdes.push(...parsed.fdes);
    errors.push(...parsed.errors);
    cfiDiagnostics.push(...parsed.cfiDiagnostics);
  }

  const preferred = preferNonOverlappingFdes(fdes);
  return {
    available: true,
    cies: cies.map(({ initialState: _initialState, ...cie }) => cie),
    fdes: preferred,
    errors,
    cfiDiagnostics,
    cfiRowCount: preferred.reduce((count, fde) => count + fde.unwindRows.length, 0)
  };
}
