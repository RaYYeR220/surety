import { isRevert } from "@surety/sdk";

export interface RetryOptions {
  /** Attempts after the first (default 5). */
  retries?: number;
  /** First delay in ms (default 500); doubles each attempt. */
  baseMs?: number;
  /** Delay cap in ms (default 30 000). */
  maxMs?: number;
  /** Which errors to retry (default: anything that is not a contract revert). */
  retryable?: (e: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (e: unknown, attempt: number, delayMs: number) => void;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Delay before retry `attempt` (1-based): base * 2^(attempt-1), capped. */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Runs `fn`, retrying RPC and transport failures with exponential backoff. Reverts are not retried. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 5;
  const retryable = options.retryable ?? ((e: unknown) => !isRevert(e));
  const wait = options.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !retryable(e)) throw e;
      const delay = backoffDelay(attempt + 1, options.baseMs, options.maxMs);
      options.onRetry?.(e, attempt + 1, delay);
      await wait(delay);
    }
  }
}
