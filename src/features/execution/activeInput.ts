export type ActiveExecutionInputSink = (text: string) => boolean;

let activeSink: ActiveExecutionInputSink | null = null;

export function registerActiveExecutionInputSink(sink: ActiveExecutionInputSink): () => void {
  activeSink = sink;
  return () => {
    if (activeSink === sink) activeSink = null;
  };
}

export function submitActiveExecutionInput(text: string): boolean {
  return activeSink?.(text) ?? false;
}
