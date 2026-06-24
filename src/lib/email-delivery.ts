import { env } from "../config/env";
import { getPublicSiteOrigin } from "./site-url";

type DeliveryResult = {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
};

type OtpEmailInput = {
  to: string;
  code: string;
  expiresInMinutes: number;
  ipAddress?: string;
  userAgent?: string;
};

type FeedbackEmailInput = {
  feedback: string;
  category?: string;
  source?: string;
  pageUrl?: string;
  userEmail?: string;
  userId?: string;
  userName?: string;
  userRole?: string;
  userStatus?: string;
  institution?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  userAgent?: string;
};

const feedbackRecipients = ["reginaldbrixton@gmail.com", "cognizap@gmail.com"];

function cleanLabel(value: string | undefined, fallback: string) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 80) : fallback;
}

function stringifyValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join(", ");
  }
  if (value === null || value === undefined || value === "") {
    return "Not provided";
  }
  return String(value);
}

function buildFeedbackMessage(input: FeedbackEmailInput) {
  const institution = input.institution ?? {};
  const profile = input.profile ?? {};
  const details = [
    ["Feedback", input.feedback],
    ["Category", cleanLabel(input.category, "General")],
    ["Source", cleanLabel(input.source, "Unknown")],
    ["Page URL", input.pageUrl],
    ["Name", input.userName],
    ["Email", input.userEmail],
    ["User ID", input.userId],
    ["Role", input.userRole],
    ["Status", input.userStatus],
    ["Institution", institution.name ?? profile.academic_institution],
    ["Department", institution.department],
    ["Position", institution.position ?? profile.job_title],
    ["Location", [institution.city, institution.country].filter(Boolean).join(", ")],
    ["Website", institution.website ?? profile.website],
    ["Research Interests", institution.research_interests ?? profile.research_interests],
    ["User Agent", input.userAgent],
  ];

  return details.map(([label, value]) => `${label}: ${stringifyValue(value)}`).join("\n");
}

function isConfigured(url: string) {
  return /^https?:\/\//i.test(url);
}

function deliveryHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (env.n8nWebhookSecret) {
    headers["X-CognizApp-Webhook-Secret"] = env.n8nWebhookSecret;
  }
  return headers;
}

function buildOtpLoginUrl(email: string) {
  const url = new URL("/login", getPublicSiteOrigin());
  url.searchParams.set("step", "code");
  url.searchParams.set("email", email);
  return url.toString();
}

async function postEmailWebhook(body: Record<string, unknown>): Promise<DeliveryResult> {
  if (!isConfigured(env.n8nGmailSendWebhookUrl)) {
    return { ok: false, status: 0, data: { skipped: true, reason: "not_configured" } };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.n8nWebhookTimeoutMs);

  try {
    const response = await fetch(env.n8nGmailSendWebhookUrl, {
      method: "POST",
      headers: deliveryHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    if (text) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = { raw: text };
      }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: { error: error instanceof Error ? error.message : "email delivery failed" },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const emailDelivery = {
  isConfigured() {
    return isConfigured(env.n8nGmailSendWebhookUrl);
  },

  sendOtpEmail(input: OtpEmailInput) {
    const actionUrl = buildOtpLoginUrl(input.to);
    return postEmailWebhook({
      type: "auth.otp",
      to: input.to,
      eventType: "auth.otp.requested",
      subject: "Your CognizApp login code",
      title: "Your CognizApp login code",
      message: `Use ${input.code} to sign in to CognizApp. This code expires in ${input.expiresInMinutes} minutes. Enter it here: ${actionUrl}`,
      actionUrl,
      loginUrl: actionUrl,
      codeEntryUrl: actionUrl,
      code: input.code,
      expiresInMinutes: input.expiresInMinutes,
      metadata: {
        authAction: "otp",
        actionUrl,
        loginUrl: actionUrl,
        codeEntryUrl: actionUrl,
        ipAddress: input.ipAddress ?? "",
        userAgent: input.userAgent ?? "",
      },
    });
  },

  async sendFeedbackEmail(input: FeedbackEmailInput) {
    const category = cleanLabel(input.category, "General");
    const userName = cleanLabel(input.userName, input.userEmail ?? "Unknown user");
    const subject = `CognizApp Feedback from ${userName} - ${category}`;
    const message = buildFeedbackMessage(input);

    const deliveries = await Promise.all(
      feedbackRecipients.map((recipient) =>
        postEmailWebhook({
          type: "notification.email",
          action: "notification.email",
          to: recipient,
          eventType: "notification.email",
          subject,
          title: subject,
          message,
          feedback: input.feedback,
          category,
          source: cleanLabel(input.source, "Unknown"),
          pageUrl: input.pageUrl ?? "",
          userEmail: input.userEmail ?? "Anonymous",
          userId: input.userId ?? "Unknown",
          userName,
          userRole: input.userRole ?? "Unknown",
          userStatus: input.userStatus ?? "Unknown",
          userAgent: input.userAgent ?? "Unknown",
          metadata: {
            feedbackAction: "user_feedback",
            originalEventType: "feedback.submitted",
            category,
            source: cleanLabel(input.source, "Unknown"),
            pageUrl: input.pageUrl ?? "",
            userEmail: input.userEmail ?? "Anonymous",
            userId: input.userId ?? "Unknown",
            userName,
            userRole: input.userRole ?? "Unknown",
            userStatus: input.userStatus ?? "Unknown",
            institution: input.institution ?? {},
            profile: input.profile ?? {},
            userAgent: input.userAgent ?? "Unknown",
          },
        }),
      ),
    );

    return {
      ok: deliveries.every((delivery) => delivery.ok),
      status: deliveries.find((delivery) => !delivery.ok)?.status ?? 200,
      data: {
        recipients: feedbackRecipients,
        deliveries: deliveries.map((delivery, index) => ({
          recipient: feedbackRecipients[index],
          ok: delivery.ok,
          status: delivery.status,
          data: delivery.data,
        })),
      },
    };
  },
};
