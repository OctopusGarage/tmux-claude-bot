import type { NotificationChannel } from "./gateway.js";

export class OwnerActivityTracker {
  private lastChannel: NotificationChannel | undefined;

  record(channel: NotificationChannel): void {
    this.lastChannel = channel;
  }

  recent(): NotificationChannel | undefined {
    return this.lastChannel;
  }
}
