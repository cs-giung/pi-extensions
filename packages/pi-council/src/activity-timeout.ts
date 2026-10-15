export type ActivityTimeoutReason = "idle-timeout" | "max-duration";

export interface ActivityTimeoutOptions {
  idleTimeoutMs: number;
  maxDurationMs: number;
  onTimeout: (reason: ActivityTimeoutReason) => void;
}

export class ActivityTimeout {
  private idleTimer: NodeJS.Timeout | undefined;
  private maxTimer: NodeJS.Timeout | undefined;
  private settled = false;
  private readonly idleTimeoutMs: number;
  private readonly onTimeout: (reason: ActivityTimeoutReason) => void;

  constructor(options: ActivityTimeoutOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.onTimeout = options.onTimeout;
    this.maxTimer = setTimeout(() => this.expire("max-duration"), options.maxDurationMs);
    this.touch();
  }

  touch(): void {
    if (this.settled) {
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.expire("idle-timeout"), this.idleTimeoutMs);
  }

  dispose(): void {
    this.settled = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.maxTimer);
  }

  private expire(reason: ActivityTimeoutReason): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.maxTimer);
    this.onTimeout(reason);
  }
}
