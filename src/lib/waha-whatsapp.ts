import { env } from "../config/env";
import { getPublicSiteOrigin } from "./site-url";

export type WhatsAppNotificationInput = {
  to: string;
  eventType: string;
  title: string;
  message: string;
  actionUrl?: string;
  metadata?: Record<string, any>;
};

export type WhatsAppNotificationResult = {
  ok: boolean;
  skipped?: boolean;
  status: number;
  sid?: string;
  messageStatus?: string;
  error?: unknown;
  data?: Record<string, any>;
};

export function wahaWhatsAppConfigured() {
  return Boolean(env.wahaBaseUrl && env.wahaApiKey);
}

export function twilioWhatsAppConfigured() {
  return wahaWhatsAppConfigured();
}

export function normalizeWhatsAppNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withoutPrefix = trimmed.replace(/^whatsapp:/i, "");
  const plus = withoutPrefix.startsWith("+") ? "+" : "";
  const digits = withoutPrefix.replace(/[^\d]/g, "");
  if (!digits) return "";
  return `whatsapp:${plus}${digits}`;
}

function toChatId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withoutPrefix = trimmed.replace(/^whatsapp:/i, "");
  const digits = withoutPrefix.replace(/[^\d]/g, "");
  if (!digits) return "";
  return `${digits}@c.us`;
}

function absoluteActionUrl(actionUrl: string | undefined) {
  const origin = getPublicSiteOrigin();
  if (!actionUrl?.trim()) return origin;
  try {
    return new URL(actionUrl.trim(), origin).toString();
  } catch {
    return origin;
  }
}

function buildCogniZapBody(input: WhatsAppNotificationInput) {
  const actionUrl = absoluteActionUrl(input.actionUrl);
  const taskId = String(input.metadata?.taskId ?? input.metadata?.requestId ?? "").trim();
  const subject = taskId ? `${input.title} (${taskId})` : input.title;
  return [
    `CogniZap update: ${subject}`,
    input.message.trim(),
    `Open your portal to check your request, files, and downloads: ${actionUrl}`,
  ].filter(Boolean).join("\n\n");
}

export async function sendWhatsAppNotification(
  input: WhatsAppNotificationInput,
): Promise<WhatsAppNotificationResult> {
  const chatId = toChatId(input.to);
  if (!chatId) {
    return { ok: false, skipped: true, status: 0, data: { reason: "missing_recipient" } };
  }
  if (!wahaWhatsAppConfigured()) {
    return { ok: false, skipped: true, status: 0, data: { reason: "waha_not_configured" } };
  }

  const text = buildCogniZapBody(input);
  const session = env.wahaSession || "default";

  const response = await fetch(
    `${env.wahaBaseUrl}/api/sendText`,
    {
      method: "POST",
      headers: {
        "X-Api-Key": env.wahaApiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        chatId,
        text,
        session,
      }),
    },
  );
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    sid: typeof data.id === "string" ? data.id : undefined,
    messageStatus: typeof data.status === "string" ? data.status : undefined,
    error: response.ok ? undefined : data,
    data,
  };
}

export async function fetchWhatsAppMessageStatus(messageId: string) {
  if (!wahaWhatsAppConfigured()) {
    return { ok: false, skipped: true, status: 0, data: { reason: "waha_not_configured" } };
  }
  const response = await fetch(
    `${env.wahaBaseUrl}/api/messages/${messageId}`,
    {
      headers: { "X-Api-Key": env.wahaApiKey },
    },
  );
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}
