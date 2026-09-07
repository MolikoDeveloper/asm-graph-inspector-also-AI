type ActiveExecutionProbeSink = () => boolean;

let sink: ActiveExecutionProbeSink | null = null;

export function registerActiveExecutionProbeSink(next: ActiveExecutionProbeSink | null): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

export function submitActiveExecutionProbe(): boolean {
  return sink?.() ?? false;
}
