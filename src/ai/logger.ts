export interface LogEvent {
  event: string;
  correlationId?: string;
  [key: string]: unknown;
}
 
export interface Logger {
  info(e: LogEvent): void;
  warn(e: LogEvent): void;
  error(e: LogEvent): void;
}
 
export class ConsoleLogger implements Logger {
  constructor(private readonly redactKeys: string[] = ['apiKey', 'authorization']) {}
 
  info(e: LogEvent): void {
    console.log(this.serialize('info', e));
  }
  warn(e: LogEvent): void {
    console.warn(this.serialize('warn', e));
  }
  error(e: LogEvent): void {
    console.error(this.serialize('error', e));
  }
 
  private serialize(level: string, e: LogEvent): string {
    const safe: Record<string, unknown> = { level, ts: new Date().toISOString() };
    for (const [k, v] of Object.entries(e)) {
      safe[k] = this.redactKeys.includes(k) ? '[redacted]' : normalize(v);
    }
    return JSON.stringify(safe);
  }
}
 

function normalize(v: unknown): unknown {
  if (v instanceof Error) {
    return { name: v.name, message: v.message, stack: v.stack };
  }
  return v;
}
 
export class NullLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}