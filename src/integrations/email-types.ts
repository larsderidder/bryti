export interface EmailTriggerBase {
  id: string;
  user_id: string;
  platform: "telegram" | "whatsapp";
  channel_id: string;
  thread_id?: string;
  channel_thread_id?: string;
  sender_allowlist: string[];
  trusted_authserv_ids: string[];
}
export type EmailTrigger = EmailTriggerBase & (
  { provider: "gmail"; account: string }
  | { provider: "imap"; imap: { host: string; port: number; user: string; password: string; mailbox: string } }
);
export interface EmailConfig { poll_interval_seconds: number; triggers: EmailTrigger[] }
export type EmailCursor =
  { provider: "gmail"; historyId: string; nextPageToken?: string; highWaterHistoryId?: string; pendingIds?: string[] }
  | { provider: "imap"; uidValidity: string; lastUid: number };
export interface EmailNotice {
  id: string;
  messageId?: string;
  headers: Array<{ name: string; value: string }>;
  subject: string;
  body: string;
}
export interface EmailPage { cursor: EmailCursor; messages: EmailNotice[]; gap?: boolean }
export type EmailReader = (cursor: EmailCursor | null, signal: AbortSignal) => Promise<EmailPage>;
