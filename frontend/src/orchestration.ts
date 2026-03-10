export type Scheduler = {
  setTimeout(handler: () => void, delayMs: number): number;
  clearTimeout(timerId: number): void;
};

export const defaultScheduler: Scheduler = {
  setTimeout: (handler, delayMs) => window.setTimeout(handler, delayMs),
  clearTimeout: (timerId) => window.clearTimeout(timerId),
};

export const sleep = async (ms: number, signal?: AbortSignal, scheduler: Scheduler = defaultScheduler): Promise<void> => {
  if (signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = scheduler.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      scheduler.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
};
