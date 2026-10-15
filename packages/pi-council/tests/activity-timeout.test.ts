import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityTimeout } from "../src/activity-timeout.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ActivityTimeout", () => {
  it("restarts the idle deadline on activity", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const timeout = new ActivityTimeout({
      idleTimeoutMs: 100,
      maxDurationMs: 1_000,
      onTimeout,
    });

    vi.advanceTimersByTime(90);
    timeout.touch();
    vi.advanceTimersByTime(90);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledWith("idle-timeout");
    timeout.dispose();
  });

  it("enforces the maximum duration despite continuing activity", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const timeout = new ActivityTimeout({
      idleTimeoutMs: 100,
      maxDurationMs: 250,
      onTimeout,
    });

    vi.advanceTimersByTime(90);
    timeout.touch();
    vi.advanceTimersByTime(90);
    timeout.touch();
    vi.advanceTimersByTime(69);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledWith("max-duration");
    timeout.dispose();
  });

  it("cancels both deadlines when disposed", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const timeout = new ActivityTimeout({
      idleTimeoutMs: 100,
      maxDurationMs: 200,
      onTimeout,
    });

    timeout.dispose();
    vi.runAllTimers();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
