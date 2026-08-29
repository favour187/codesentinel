










export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key|credential|signature)/i;

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > 8) return `${value.slice(0, 2)}***redacted***`;
    return '***redacted***';
  }
  return '***redacted***';
}

export function redact(input: unknown, depth = 0): unknown {
  if (depth > 6 || input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));
  if (input instanceof Error) {
    return { name: input.name, message: input.message, stack: input.stack };
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? redactValue(v) : redact(v, depth + 1);
    }
    return out;
  }
  return input;
}

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: LogLevel, scope: string, bindings: Record<string, unknown>, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  if (process.env.NODE_ENV === 'test' && level !== 'error') return;

  const payload = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(redact(bindings) as Record<string, unknown>),
    ...(meta ? (redact(meta) as Record<string, unknown>) : {}),
  };

  const line =
    process.env.NODE_ENV === 'production'
      ? JSON.stringify(payload)
      : `${payload.ts.slice(11, 23)} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}` +
        (meta ? ` ${JSON.stringify(redact(meta))}` : '');

  // eslint-disable-next-line no-console
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line);
}

export function createLogger(scope: string, bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, bindings, m, meta),
    info: (m, meta) => emit('info', scope, bindings, m, meta),
    warn: (m, meta) => emit('warn', scope, bindings, m, meta),
    error: (m, meta) => emit('error', scope, bindings, m, meta),
    child: (extra) => createLogger(scope, { ...bindings, ...extra }),
  };
}

export const logger = createLogger('app');
