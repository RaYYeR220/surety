export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: Level;
  /** Strings scrubbed from every line (the private key). */
  secrets?: string[];
  /** Where lines go (default: stdout for info and below, stderr for warn and error). */
  write?: (line: string, level: Level) => void;
  /** Clock, for tests. */
  now?: () => Date;
}

function errorFields(e: Error): Record<string, unknown> {
  const short = (e as { shortMessage?: string }).shortMessage;
  return { name: e.name, message: short ?? e.message.split("\n")[0] };
}

function serialise(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Error) return errorFields(v);
      return v;
    }),
  );
}

/** One JSON object per line: `{ ts, level, msg, ...fields }`. Secrets are replaced by "[redacted]". */
export function createLogger(options: LoggerOptions = {}, base: Record<string, unknown> = {}): Logger {
  const min = ORDER[options.level ?? "info"];
  const secrets = (options.secrets ?? []).filter((s) => s.length >= 8);
  const write =
    options.write ??
    ((line: string, level: Level) => {
      if (ORDER[level] >= ORDER.warn) process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    });
  const now = options.now ?? (() => new Date());

  const emit = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < min) return;
    let line = JSON.stringify(serialise({ ts: now().toISOString(), level, msg, ...base, ...fields }));
    for (const secret of secrets) {
      line = line.split(secret).join("[redacted]");
      const bare = secret.startsWith("0x") ? secret.slice(2) : secret;
      if (bare.length >= 8) line = line.split(bare).join("[redacted]");
    }
    write(line, level);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger(options, { ...base, ...fields }),
  };
}
