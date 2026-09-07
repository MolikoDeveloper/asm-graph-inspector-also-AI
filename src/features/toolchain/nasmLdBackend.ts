import type {
  AssemblerBackend,
  AssemblyArtifact,
  AssemblyDiagnostic,
  AssemblyRequest,
  AssemblyResult,
  AssemblySourceFile
} from './model';
import { findToolOutput, type ToolFile, type ToolProcessResult, type ToolProcessRunner } from './toolProcess';

const DEFAULT_OUTPUT = '/work/build/program';
const DEFAULT_ENTRY = '_start';

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'source.asm';
}

function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function safeStem(path: string): string {
  const normalized = stem(path).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'source';
}

function objectPath(source: AssemblySourceFile, index: number): string {
  return `/work/obj/${String(index).padStart(3, '0')}-${safeStem(source.path)}.o`;
}

function sourcePath(source: AssemblySourceFile, index: number): string {
  return `/work/src/${String(index).padStart(3, '0')}-${basename(source.path)}`;
}

function diagnosticFromProcess(tool: string, result: ToolProcessResult): AssemblyDiagnostic[] {
  if (result.exitCode === 0) return [];
  const text = result.stderr.trim() || result.stdout.trim() || `${tool} exited with code ${result.exitCode}.`;
  return text.split(/\r?\n/).filter(Boolean).map((message) => ({ severity: 'error', message, tool }));
}

function artifact(path: string, kind: AssemblyArtifact['kind'], bytes: Uint8Array, generatedBy: string): AssemblyArtifact {
  return { path, kind, bytes, generatedBy };
}

export interface NasmLdBackendOptions {
  nasmExecutable?: string;
  ldExecutable?: string;
}

export class NasmLdAssemblerBackend implements AssemblerBackend {
  readonly id = 'nasm-ld-linux-x86-64';
  readonly name = 'NASM + GNU ld (Linux x86-64)';

  private readonly nasmExecutable: string;
  private readonly ldExecutable: string;

  constructor(
    private readonly runner: ToolProcessRunner,
    options: NasmLdBackendOptions = {}
  ) {
    this.nasmExecutable = options.nasmExecutable ?? '/toolchain/bin/nasm';
    this.ldExecutable = options.ldExecutable ?? '/toolchain/bin/ld';
  }

  async assemble(request: AssemblyRequest): Promise<AssemblyResult> {
    const diagnostics: AssemblyDiagnostic[] = [];
    const generatedArtifacts: AssemblyArtifact[] = [];
    let stdout = '';
    let stderr = '';

    if (!request.sources.length) {
      return {
        success: false,
        artifact: null,
        generatedArtifacts,
        diagnostics: [{ severity: 'error', message: 'No ASM source files were provided.' }],
        stdout,
        stderr
      };
    }

    const objectFiles: ToolFile[] = [];

    for (let index = 0; index < request.sources.length; index += 1) {
      const source = request.sources[index];
      const inputPath = sourcePath(source, index);
      const outputPath = objectPath(source, index);
      const sourceBytes = new TextEncoder().encode(source.source);
      const result = await this.runner.run({
        executable: this.nasmExecutable,
        args: ['-f', 'elf64', inputPath, '-o', outputPath, ...(request.assemblerArgs ?? [])],
        cwd: '/work',
        files: [{ path: inputPath, bytes: sourceBytes }],
        captureFiles: [outputPath]
      });

      stdout += result.stdout;
      stderr += result.stderr;
      diagnostics.push(...diagnosticFromProcess('nasm', result));
      if (result.exitCode !== 0) {
        return { success: false, artifact: null, generatedArtifacts, diagnostics, stdout, stderr };
      }

      const output = findToolOutput(result, outputPath);
      if (!output) {
        diagnostics.push({ severity: 'error', message: `NASM did not produce expected object ${outputPath}.`, tool: 'nasm' });
        return { success: false, artifact: null, generatedArtifacts, diagnostics, stdout, stderr };
      }
      objectFiles.push(output);
      generatedArtifacts.push(artifact(output.path, 'elf-object', output.bytes, 'nasm'));
    }

    const outputPath = request.outputPath ?? DEFAULT_OUTPUT;
    const entrySymbol = request.entrySymbol ?? DEFAULT_ENTRY;
    const linkResult = await this.runner.run({
      executable: this.ldExecutable,
      args: ['-o', outputPath, '-e', entrySymbol, ...objectFiles.map((file) => file.path), ...(request.linkerArgs ?? [])],
      cwd: '/work',
      files: objectFiles,
      captureFiles: [outputPath]
    });

    stdout += linkResult.stdout;
    stderr += linkResult.stderr;
    diagnostics.push(...diagnosticFromProcess('ld', linkResult));
    if (linkResult.exitCode !== 0) {
      return { success: false, artifact: null, generatedArtifacts, diagnostics, stdout, stderr };
    }

    const linked = findToolOutput(linkResult, outputPath);
    if (!linked) {
      diagnostics.push({ severity: 'error', message: `GNU ld did not produce expected executable ${outputPath}.`, tool: 'ld' });
      return { success: false, artifact: null, generatedArtifacts, diagnostics, stdout, stderr };
    }

    const executable = artifact(linked.path, 'elf-executable', linked.bytes, 'nasm+ld');
    generatedArtifacts.push(executable);
    return { success: true, artifact: executable, generatedArtifacts, diagnostics, stdout, stderr };
  }
}
