export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

interface AppendOnlyChannel {
  appendLine(line: string): void;
}

const formatError = (error: unknown): string => {
  if (error === undefined) return "";
  if (error instanceof Error) return ` ${error.stack ?? error.message}`;
  return ` ${String(error)}`;
};

export const createOutputChannelLogger = (channel: AppendOnlyChannel): Logger => ({
  info: (message) => channel.appendLine(`[info] ${message}`),
  warn: (message) => channel.appendLine(`[warn] ${message}`),
  error: (message, error) => channel.appendLine(`[error] ${message}${formatError(error)}`),
});
