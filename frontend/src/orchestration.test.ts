import { describe, expect, it, vi } from "vitest";
import { sleep } from "./orchestration";

describe("sleep", () => {
  it("resolves on timer", async () => {
    vi.useFakeTimers();
    let done = false;
    const task = sleep(100).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    await task;
    expect(done).toBe(true);
  });

  it("resolves early when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let done = false;
    const task = sleep(1000, controller.signal).then(() => {
      done = true;
    });

    controller.abort();
    await vi.runAllTimersAsync();
    await task;
    expect(done).toBe(true);
  });
});
