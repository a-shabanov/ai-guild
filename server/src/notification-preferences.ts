import type { Actor } from './auth.ts';
import { q1 } from './db.ts';

export const DEFAULT_NOTIFICATIONS = {
  comments: true, results: true, statuses: true, assignments: true,
  tasks: true, attachments: true, activity: true,
};
export type NotificationPreferences = typeof DEFAULT_NOTIFICATIONS;

export function resolvePreferences(value: unknown): NotificationPreferences {
  const result = { ...DEFAULT_NOTIFICATIONS };
  if (value && typeof value === 'object') {
    for (const key of Object.keys(result) as Array<keyof NotificationPreferences>) {
      const saved = (value as Record<string, unknown>)[key];
      if (typeof saved === 'boolean') result[key] = saved;
    }
  }
  return result;
}

export function wantsNotification(type: string, preferences: unknown): boolean {
  const categories: Record<string, keyof NotificationPreferences> = {
    comment_added: 'comments', result_submitted: 'results', status_changed: 'statuses',
    task_assigned: 'assignments', task_created: 'tasks', attachment_added: 'attachments',
  };
  return resolvePreferences(preferences)[categories[type] ?? 'activity'];
}

export async function getPreferences(actor: Actor): Promise<NotificationPreferences> {
  const row = await q1('select preferences from notification_preferences where account_id = $1', [actor.id]);
  return resolvePreferences(row?.preferences);
}

export async function updatePreferences(actor: Actor, changes: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
  // Merge in Postgres so concurrent changes to different switches cannot erase one another.
  const row = await q1(`insert into notification_preferences(account_id, preferences) values ($1, $2::jsonb)
    on conflict(account_id) do update set preferences = notification_preferences.preferences || excluded.preferences
    returning preferences`, [actor.id, JSON.stringify(changes)]);
  return resolvePreferences(row!.preferences);
}
