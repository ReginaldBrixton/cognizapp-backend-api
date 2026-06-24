import { env } from "../config/env";

type WebhookResult = {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
};

type NotificationEmailInput = {
  to: string;
  userId: string;
  eventType: string;
  title: string;
  message: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
};

function isConfigured(url: string) {
  return /^https?:\/\//i.test(url);
}

function webhookHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (env.n8nWebhookSecret) {
    headers["X-CognizApp-Webhook-Secret"] = env.n8nWebhookSecret;
  }
  return headers;
}

async function postGmailWebhook(body: Record<string, unknown>): Promise<WebhookResult> {
  if (!isConfigured(env.n8nGmailSendWebhookUrl)) {
    return { ok: false, status: 0, data: { skipped: true, reason: "not_configured" } };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.n8nWebhookTimeoutMs);

  try {
    const response = await fetch(env.n8nGmailSendWebhookUrl, {
      method: "POST",
      headers: webhookHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    if (text) {
      try {
        const parsed = JSON.parse(text);
        data = Array.isArray(parsed)
          ? ((parsed[0] as Record<string, unknown>) ?? { items: parsed })
          : (parsed as Record<string, unknown>);
      } catch {
        data = { raw: text };
      }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: {
        error: error instanceof Error ? error.message : "n8n Gmail webhook request failed",
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const n8nService = {
  isEmailConfigured() {
    return isConfigured(env.n8nGmailSendWebhookUrl);
  },

  async sendNotificationEmail(input: NotificationEmailInput) {
    return postGmailWebhook({
      type: "notification.email",
      action: "gmail.send",
      to: input.to,
      userId: input.userId,
      eventType: input.eventType,
      subject: input.title,
      title: input.title,
      message: input.message,
      actionUrl: input.actionUrl ?? "",
      metadata: input.metadata ?? {},
      template: {
        product: "CognizApp",
        tone: "modern",
        includePortalCta: true,
      },
    });
  },
};
