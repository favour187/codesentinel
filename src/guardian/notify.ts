import { getDb } from '@/db';
import { notifications } from '@/db/schema';

/**
 * Provider-independent notifications.
 *
 * The only built-in sink is the in-app `notifications` table. Additional
 * providers implement `NotificationSink` and register here — nothing in
 * Guardian imports Slack, email or GitHub for this purpose.
 */

export interface NotificationMessage {
  readonly repositoryId: string;
  readonly userId?: string | null;
  readonly level: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly body?: string;
  readonly link?: string;
}

export interface NotificationSink {
  readonly id: string;
  send(message: NotificationMessage): Promise<void>;
}

class InAppSink implements NotificationSink {
  readonly id = 'in-app';

  async send(message: NotificationMessage): Promise<void> {
    const db = await getDb();
    await db.insert(notifications).values({
      repositoryId: message.repositoryId,
      userId: message.userId ?? null,
      level: message.level,
      title: message.title,
      body: message.body ?? null,
      link: message.link ?? null,
    });
  }
}

const sinks: NotificationSink[] = [new InAppSink()];

export function registerNotificationSink(sink: NotificationSink): void {
  if (!sinks.some((s) => s.id === sink.id)) sinks.push(sink);
}

export async function notify(message: NotificationMessage): Promise<void> {
  for (const sink of sinks) {
    await sink.send(message);
  }
}

export function listNotificationSinks(): string[] {
  return sinks.map((s) => s.id);
}
