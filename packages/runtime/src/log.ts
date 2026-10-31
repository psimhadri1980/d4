import pino from 'pino';

/**
 * One JSON object per line on stdout: `time`, `level`, `service`, `message` and the given fields.
 * The API logs the same shape (nestjs-pino), so one query reads every service. LOG_LEVEL sets
 * the level (default info; tests use warn).
 */
export function createLogger(service: string, destination?: pino.DestinationStream) {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { service },
      messageKey: 'message',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}

export type Logger = ReturnType<typeof createLogger>;

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
