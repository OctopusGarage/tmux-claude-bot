import type { NotificationChannel } from "./gateway.js";

export class OwnerActivityTracker {
  private lastChannel: NotificationChannel | undefined;
  private lastAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  record(channel: NotificationChannel): void {
    this.lastChannel = channel;
    this.lastAt = this.now();
  }

  recent(): NotificationChannel | undefined {
    return this.lastChannel;
  }

  lastObservedAt(): number | null {
    return this.lastAt;
  }
}
