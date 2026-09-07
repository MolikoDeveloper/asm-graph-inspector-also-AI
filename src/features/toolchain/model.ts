export type AssemblyArtifactKind = 'elf-executable' | 'elf-object' | 'flat-binary';
export type AssemblyDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface AssemblySourceFile {
  path: string;
  source: string;
}

export interface AssemblyDiagnostic {
  severity: AssemblyDiagnosticSeverity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  tool?: string;
}

export interface AssemblyArtifact {
  path: string;
  kind: AssemblyArtifactKind;
  bytes: Uint8Array;
  generatedBy: string;
}

export interface AssemblyRequest {
  sources: AssemblySourceFile[];
  entrySymbol?: string;
  outputPath?: string;
  assemblerArgs?: string[];
  linkerArgs?: string[];
}

export interface AssemblyResult {
  success: boolean;
  artifact: AssemblyArtifact | null;
  generatedArtifacts: AssemblyArtifact[];
  diagnostics: AssemblyDiagnostic[];
  stdout: string;
  stderr: string;
}

export interface AssemblerBackend {
  readonly id: string;
  readonly name: string;
  assemble(request: AssemblyRequest): Promise<AssemblyResult>;
}
