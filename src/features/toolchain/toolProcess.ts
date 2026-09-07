export interface ToolFile {
  path: string;
  bytes: Uint8Array;
  executable?: boolean;
}

export interface ToolProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  files: ToolFile[];
  captureFiles: string[];
  stdin?: Uint8Array;
  env?: Record<string, string>;
}

export interface ToolProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  files: ToolFile[];
}

/**
 * Executes one isolated userspace tool process against an explicit virtual
 * filesystem snapshot. Implementations must not inherit host/browser files.
 */
export interface ToolProcessRunner {
  run(request: ToolProcessRequest): Promise<ToolProcessResult>;
}

export function findToolOutput(result: ToolProcessResult, path: string): ToolFile | null {
  return result.files.find((file) => file.path === path) ?? null;
}
