import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { EmailConfig, EmailTrigger } from "./email-types.js";

const alias = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,100}$" });
const properties = {
  id: alias, user_id: alias,
  platform: Type.Union([Type.Literal("telegram"), Type.Literal("whatsapp")]),
  channel_id: Type.String({ minLength: 1, maxLength: 100 }),
  thread_id: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" })),
  channel_thread_id: Type.Optional(Type.String({ pattern: "^\\d{1,20}$" })),
  sender_allowlist: Type.Array(Type.String({ maxLength: 320, pattern: "^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,63}$" }), { minItems: 1, maxItems: 100 }),
  trusted_authserv_ids: Type.Optional(Type.Array(Type.String({ pattern: "^[a-zA-Z0-9.-]{1,253}$" }), { minItems: 1, maxItems: 20 })),
};
const schema = Type.Object({
  poll_interval_seconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 3600 })),
  triggers: Type.Array(Type.Union([
    Type.Object({ ...properties, provider: Type.Literal("gmail"), account: Type.Optional(alias) }, { additionalProperties: false }),
    Type.Object({ ...properties, provider: Type.Literal("imap"), imap: Type.Object({
      host: Type.String({ minLength: 1, maxLength: 253, pattern: "^[a-zA-Z0-9.:-]+$" }),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
      secure: Type.Optional(Type.Literal(true)),
      user: Type.String({ minLength: 1, maxLength: 1000 }), password: Type.String({ minLength: 1, maxLength: 1000 }),
      mailbox: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    }, { additionalProperties: false }) }, { additionalProperties: false }),
  ]), { maxItems: 20 }),
}, { additionalProperties: false });

/** Parse explicit email opt-in without ever echoing password-bearing configuration in validation errors. */
export function emailFromConfig(value: unknown): EmailConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Value.Check(schema, value)) {
    throw new Error("Invalid email configuration. Use bounded polling, explicit routing, sender allowlists, and verified TLS.");
  }
  const raw = value as Static<typeof schema>;
  const ids = new Set<string>();
  const triggers: EmailTrigger[] = [];
  for (const trigger of raw.triggers) {
    if (ids.has(trigger.id)) {
      throw new Error("Email trigger IDs must be unique");
    }
    ids.add(trigger.id);
    const base = { ...trigger, sender_allowlist: trigger.sender_allowlist.map((address) => address.toLowerCase()), trusted_authserv_ids: (trigger.trusted_authserv_ids ?? []).map((id) => id.toLowerCase()) };
    if (trigger.provider === "gmail") {
      if (base.trusted_authserv_ids.some((id) => id !== "mx.google.com")) {
        throw new Error("Gmail email triggers trust only mx.google.com authentication results");
      }
      triggers.push({ ...base, provider: "gmail", account: trigger.account ?? "personal", trusted_authserv_ids: ["mx.google.com"] });
    } else {
      if (base.trusted_authserv_ids.length === 0) {
        throw new Error("IMAP email triggers require trusted_authserv_ids for the receiving mail server");
      }
      triggers.push({ ...base, provider: "imap", imap: { ...trigger.imap, port: trigger.imap.port ?? 993, mailbox: trigger.imap.mailbox ?? "INBOX" } });
    }
  }
  return { poll_interval_seconds: raw.poll_interval_seconds ?? 60, triggers };
}
