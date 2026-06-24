import { env } from "../config/env";
import { getPublicSiteOrigin } from "./site-url";

const TWILIO_MESSAGES_PATH = "/2010-04-01/Accounts";

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

export function twilioWhatsAppConfigured() {
  return Boolean(
    env.twilioAccountSid &&
      env.twilioAuthToken &&
      env.twilioWhatsAppFrom,
  );
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

function buildTemplateVariables(input: WhatsAppNotificationInput) {
  const actionUrl = absoluteActionUrl(input.actionUrl);
  const deadline = input.metadata?.deadlineAt
    ? new Date(String(input.metadata.deadlineAt)).toLocaleDateString("en-GB", {
        timeZone: "Africa/Accra",
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "your portal";
  return JSON.stringify({
    "1": `CogniZap: ${input.title}`.slice(0, 120),
    "2": deadline,
    "3": actionUrl,
  });
}

function authHeader() {
  const encoded = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

export async function sendWhatsAppNotification(
  input: WhatsAppNotificationInput,
): Promise<WhatsAppNotificationResult> {
  const to = normalizeWhatsAppNumber(input.to);
  if (!to) {
    return { ok: false, skipped: true, status: 0, data: { reason: "missing_recipient" } };
  }
  if (!twilioWhatsAppConfigured()) {
    return { ok: false, skipped: true, status: 0, data: { reason: "twilio_not_configured" } };
  }

  const form = new URLSearchParams();
  form.set("To", to);
  form.set("From", normalizeWhatsAppNumber(env.twilioWhatsAppFrom));
  if (env.twilioWhatsAppContentSid) {
    form.set("ContentSid", env.twilioWhatsAppContentSid);
    form.set("ContentVariables", buildTemplateVariables(input));
  } else {
    form.set("Body", buildCogniZapBody(input));
  }

  const response = await fetch(
    `https://api.twilio.com${TWILIO_MESSAGES_PATH}/${env.twilioAccountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    },
  );
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    sid: typeof data.sid === "string" ? data.sid : undefined,
    messageStatus: typeof data.status === "string" ? data.status : undefined,
    error: response.ok ? undefined : data,
    data,
  };
}

export async function fetchWhatsAppMessageStatus(messageSid: string) {
  if (!twilioWhatsAppConfigured()) {
    return { ok: false, skipped: true, status: 0, data: { reason: "twilio_not_configured" } };
  }
  const response = await fetch(
    `https://api.twilio.com${TWILIO_MESSAGES_PATH}/${env.twilioAccountSid}/Messages/${messageSid}.json`,
    {
      headers: { Authorization: authHeader() },
    },
  );
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}
