const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;

export interface RetryOptions {
  isRetryable: (error: unknown) => boolean;
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
}

/** 間隔を延ばしながら最大 5 回再試行する（設計書 4.9）。 */
export async function withRetry<T>(run: () => Promise<T>, options: RetryOptions): Promise<T> {
  const random = options.random ?? Math.random;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= MAX_RETRIES || !options.isRetryable(error)) throw error;
      await options.sleep(BASE_DELAY_MS * 2 ** attempt + random() * BASE_DELAY_MS);
    }
  }
}
