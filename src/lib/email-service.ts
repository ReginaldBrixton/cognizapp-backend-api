import { env } from "../config/env";
import { getPublicSiteOrigin } from "./site-url";

const USER_PORTAL = "https://cognizapp.com";
const PROVIDER_PORTAL = "https://provider.cognizapp.com";
const ADMIN_PORTAL = "https://admin.cognizapp.com";

type EmailResult = {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
};

type EmailPayload = {
  to: string;
  eventType: string;
  subject: string;
  message: string;
  actionUrl?: string;
  code?: string;
  requestId?: string;
  taskId?: string;
  userName?: string;
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

async function postWebhook(body: Record<string, unknown>): Promise<EmailResult> {
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
      data: { error: error instanceof Error ? error.message : "email webhook failed" },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildActionUrl(path?: string): string {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const origin = getPublicSiteOrigin();
  return new URL(path, origin).toString();
}

export const emailService = {
  isConfigured() {
    return isConfigured(env.n8nGmailSendWebhookUrl);
  },

  async sendOtp(input: {
    to: string;
    code: string;
    expiresInMinutes: number;
    ipAddress?: string;
    userAgent?: string;
    magicLinkUrl?: string;
  }): Promise<EmailResult> {
    const actionUrl = buildActionUrl(`/login?step=code&email=${encodeURIComponent(input.to)}`);
    return postWebhook({
      type: "notification.email",
      eventType: "auth.otp.requested",
      to: input.to,
      subject: "Your CogniZap login code",
      title: "Your CogniZap login code",
      message: `Click the "Sign in instantly" button below to log in with one click, or enter the 6-digit code manually if you prefer. Valid for ${input.expiresInMinutes} minutes.`,
      actionUrl,
      code: input.code,
      magicLinkUrl: input.magicLinkUrl ?? "",
      expiresInMinutes: input.expiresInMinutes,
      metadata: {
        authAction: "otp",
        actionUrl,
        magicLinkUrl: input.magicLinkUrl ?? "",
        ipAddress: input.ipAddress ?? "",
        userAgent: input.userAgent ?? "",
      },
    });
  },

  async sendPaymentVerified(input: {
    to: string;
    userId: string;
    requestId: string;
    requestTitle: string;
    amount: number;
    currency: string;
    paymentType: string;
    deadlineAt?: string | null;
    actionUrl?: string;
  }): Promise<EmailResult> {
    const deadline = input.deadlineAt
      ? new Date(input.deadlineAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
      : "the agreed deadline";
    return postWebhook({
      type: "notification.email",
      eventType: "support.payment.verified",
      to: input.to,
      userId: input.userId,
      subject: "Payment confirmed",
      title: "Payment confirmed",
      message: `We received your ${input.paymentType} payment of ${input.currency} ${input.amount.toLocaleString()}. Your request "${input.requestTitle}" is confirmed. Expected delivery: ${deadline}.`,
      requestId: input.requestId,
      actionUrl: buildActionUrl(input.actionUrl ?? `/support/requests/${input.requestId}`),
      metadata: { requestId: input.requestId, amount: input.amount, currency: input.currency },
    });
  },

  async sendDeliveryUploaded(input: {
    to: string;
    userId: string;
    requestId: string;
    requestTitle: string;
    actionUrl?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "support.delivery.uploaded",
      to: input.to,
      userId: input.userId,
      subject: "Your work is ready",
      title: "Your work is ready",
      message: `The completed work for "${input.requestTitle}" has been uploaded and is ready for review.`,
      requestId: input.requestId,
      actionUrl: buildActionUrl(input.actionUrl ?? `/support/requests/${input.requestId}`),
      metadata: { requestId: input.requestId },
    });
  },

  async sendAdminReply(input: {
    to: string;
    userId: string;
    requestId: string;
    message: string;
    actionUrl?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "support.message.admin_reply",
      to: input.to,
      userId: input.userId,
      subject: "New message from support",
      title: "New message from support",
      message: input.message,
      requestId: input.requestId,
      actionUrl: buildActionUrl(input.actionUrl ?? `/support/requests/${input.requestId}`),
      metadata: { requestId: input.requestId },
    });
  },

  async sendProviderReply(input: {
    to: string;
    userId: string;
    requestId: string;
    message: string;
    actionUrl?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "support.message.provider_reply",
      to: input.to,
      userId: input.userId,
      subject: "New message from provider",
      title: "New message from provider",
      message: input.message,
      requestId: input.requestId,
      actionUrl: buildActionUrl(input.actionUrl ?? `/support/requests/${input.requestId}`),
      metadata: { requestId: input.requestId },
    });
  },

  async sendClientReply(input: {
    to: string;
    userId: string;
    requestId: string;
    message: string;
    actionUrl?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "support.message.client_reply",
      to: input.to,
      userId: input.userId,
      subject: "New message from client",
      title: "New message from client",
      message: input.message,
      requestId: input.requestId,
      actionUrl: buildActionUrl(input.actionUrl ?? `/support/requests/${input.requestId}`),
      metadata: { requestId: input.requestId },
    });
  },

  async sendWorkStarted(input: {
    to: string;
    userId: string;
    requestId: string;
    requestTitle: string;
    actionUrl?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "support.work_started",
      to: input.to,
      userId: input.userId,
      subject: "Work has started",
      title: "Work has started",
      message: `Work on your request "${input.requestTitle}" has begun. You'll be notified when it's delivered.`,
      requestId: input.requestId,
      actionUrl: buildActionUrl(input.actionUrl ?? `/support/requests/${input.requestId}`),
      metadata: { requestId: input.requestId },
    });
  },

  async sendRequestCompleted(input: {
    to: string;
    userId: string;
    requestId: string;
    requestTitle: string;
    actionUrl?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "support.request.completed",
      to: input.to,
      userId: input.userId,
      subject: "Request completed",
      title: "Request completed",
      message: `Your request "${input.requestTitle}" has been marked as completed. Thank you for using CogniZap.`,
      requestId: input.requestId,
      actionUrl: buildActionUrl(input.actionUrl ?? `/support/requests/${input.requestId}`),
      metadata: { requestId: input.requestId },
    });
  },

  async sendRequestSubmitted(input: {
    to: string;
    userId: string;
    requestId: string;
    requestTitle: string;
    actionUrl?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "support.request.submitted",
      to: input.to,
      userId: input.userId,
      subject: "Request submitted",
      title: "Request submitted",
      message: `Your request "${input.requestTitle}" has been submitted for review. We'll start processing it shortly.`,
      requestId: input.requestId,
      actionUrl: buildActionUrl(input.actionUrl ?? `/support/requests/${input.requestId}`),
      metadata: { requestId: input.requestId },
    });
  },

  async sendDiscountDecision(input: {
    to: string;
    userId: string;
    requestId: string;
    requestTitle: string;
    approved: boolean;
    newAmount?: number;
    currency: string;
    actionUrl?: string;
  }): Promise<EmailResult> {
    const message = input.approved
      ? `Your discount request for "${input.requestTitle}" has been approved. The new price is ${input.currency} ${input.newAmount?.toLocaleString() ?? ""}.`
      : `Your discount request for "${input.requestTitle}" was not approved. The original price remains ${input.currency} ${input.newAmount?.toLocaleString() ?? ""}.`;
    return postWebhook({
      type: "notification.email",
      eventType: "support.discount.decision",
      to: input.to,
      userId: input.userId,
      subject: input.approved ? "Discount approved" : "Discount request update",
      title: input.approved ? "Discount approved" : "Discount request update",
      message,
      requestId: input.requestId,
      actionUrl: buildActionUrl(input.actionUrl ?? `/support/requests/${input.requestId}`),
      metadata: { requestId: input.requestId, approved: input.approved },
    });
  },

  async sendAdminAccessGranted(input: {
    to: string;
    userId: string;
    role: string;
    displayName?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "admin.privileged_access.granted",
      to: input.to,
      userId: input.userId,
      subject: "Admin access granted",
      title: "Admin access granted",
      message: `You've been granted ${input.role} access to CogniZap. Sign in with this email to access the admin portal.`,
      actionUrl: ADMIN_PORTAL,
      userName: input.displayName ?? "",
      metadata: { role: input.role, portal: ADMIN_PORTAL },
    });
  },

  async sendAdminAccessRevoked(input: {
    to: string;
    userId: string;
    role: string;
    displayName?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "admin.privileged_access.revoked",
      to: input.to,
      userId: input.userId,
      subject: "Admin access removed",
      title: "Admin access removed",
      message: `Your ${input.role} access to CogniZap has been removed. You will no longer be able to sign in to the admin portal. Contact the CogniZap team if you believe this was a mistake.`,
      actionUrl: `${USER_PORTAL}/login`,
      userName: input.displayName ?? "",
      metadata: { role: input.role },
    });
  },

  async sendAdminAccessUpdated(input: {
    to: string;
    userId: string;
    role: string;
    displayName?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "admin.privileged_access.updated",
      to: input.to,
      userId: input.userId,
      subject: "Admin account updated",
      title: "Admin account updated",
      message: `Your ${input.role} account on CogniZap was updated by an administrator. If you did not expect this change, please reach out to the CogniZap team.`,
      actionUrl: ADMIN_PORTAL,
      userName: input.displayName ?? "",
      metadata: { role: input.role },
    });
  },

  async sendProviderAccessGranted(input: {
    to: string;
    userId: string;
    displayName?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "provider.access.granted",
      to: input.to,
      userId: input.userId,
      subject: "Provider access granted",
      title: "Provider access granted",
      message: `You've been granted provider access to CogniZap. Sign in with this email to access the provider portal.`,
      actionUrl: PROVIDER_PORTAL,
      userName: input.displayName ?? "",
      metadata: { portal: PROVIDER_PORTAL },
    });
  },

  async sendProviderAccessRevoked(input: {
    to: string;
    userId: string;
    displayName?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "provider.access.revoked",
      to: input.to,
      userId: input.userId,
      subject: "Provider access removed",
      title: "Provider access removed",
      message: `Your provider access to CogniZap has been removed. You will no longer be able to sign in to the provider portal. Contact the CogniZap team if you believe this was a mistake.`,
      actionUrl: `${USER_PORTAL}/login`,
      userName: input.displayName ?? "",
      metadata: {},
    });
  },

  async sendProviderAccessUpdated(input: {
    to: string;
    userId: string;
    displayName?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "provider.access.updated",
      to: input.to,
      userId: input.userId,
      subject: "Provider account updated",
      title: "Provider account updated",
      message: `Your provider account on CogniZap was updated by an administrator. If you did not expect this change, please reach out to the CogniZap team.`,
      actionUrl: PROVIDER_PORTAL,
      userName: input.displayName ?? "",
      metadata: {},
    });
  },

  async sendDeviceLoginAlert(input: {
    to: string;
    userId: string;
    deviceInfo: string;
    location?: string;
    ipAddress?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "auth.device.new_login",
      to: input.to,
      userId: input.userId,
      subject: "New device login",
      title: "New device login detected",
      message: `A new login was detected on your CogniZap account. If this was you, no action is needed. If not, please secure your account immediately.`,
      actionUrl: `${USER_PORTAL}/settings/security`,
      deviceInfo: input.deviceInfo,
      locationInfo: input.location ?? "",
      metadata: {
        deviceInfo: input.deviceInfo,
        location: input.location ?? "",
        ipAddress: input.ipAddress ?? "",
      },
    });
  },

  async sendProfileUpdated(input: {
    to: string;
    userId: string;
    changes: string[];
  }): Promise<EmailResult> {
    const changeList = input.changes.length > 0 ? input.changes.join(", ") : "your profile";
    return postWebhook({
      type: "notification.email",
      eventType: "auth.profile.updated",
      to: input.to,
      userId: input.userId,
      subject: "Profile updated",
      title: "Your profile was updated",
      message: `The following was updated on your CogniZap profile: ${changeList}. If you did not make these changes, please contact support immediately.`,
      actionUrl: `${USER_PORTAL}/settings/profile`,
      metadata: { changes: input.changes },
    });
  },

  async sendAdNotification(input: {
    to: string;
    userId?: string;
    title: string;
    message: string;
    actionUrl?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "notification.ads",
      to: input.to,
      userId: input.userId ?? "",
      subject: input.title,
      title: input.title,
      message: input.message,
      actionUrl: input.actionUrl ?? USER_PORTAL,
      metadata: { notificationType: "ad" },
    });
  },

  async sendUpdateNotification(input: {
    to: string;
    userId?: string;
    title: string;
    message: string;
    actionUrl?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "notification.updates",
      to: input.to,
      userId: input.userId ?? "",
      subject: input.title,
      title: input.title,
      message: input.message,
      actionUrl: input.actionUrl ?? USER_PORTAL,
      metadata: { notificationType: "update" },
    });
  },

  async sendChangeNotification(input: {
    to: string;
    userId?: string;
    title: string;
    message: string;
    actionUrl?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "notification.changes",
      to: input.to,
      userId: input.userId ?? "",
      subject: input.title,
      title: input.title,
      message: input.message,
      actionUrl: input.actionUrl ?? USER_PORTAL,
      metadata: { notificationType: "change" },
    });
  },

  async sendDiscountOffer(input: {
    to: string;
    userId?: string;
    title: string;
    message: string;
    actionUrl?: string;
  }): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: "notification.discount_offers",
      to: input.to,
      userId: input.userId ?? "",
      subject: input.title,
      title: input.title,
      message: input.message,
      actionUrl: input.actionUrl ?? USER_PORTAL,
      metadata: { notificationType: "discount_offer" },
    });
  },

  async sendFeedback(input: {
    feedback: string;
    category?: string;
    source?: string;
    pageUrl?: string;
    userEmail?: string;
    userId?: string;
    userName?: string;
    userRole?: string;
    userAgent?: string;
  }): Promise<EmailResult> {
    const recipients = ["reginaldbrixton@gmail.com", "cognizap@gmail.com"];
    const userName = input.userName?.trim() || input.userEmail || "Anonymous";
    const category = input.category?.trim() || "General";
    const subject = `Feedback from ${userName} - ${category}`;

    const details = [
      `Feedback: ${input.feedback}`,
      `Category: ${category}`,
      `Source: ${input.source || "Unknown"}`,
      `Page URL: ${input.pageUrl || "Not provided"}`,
      `Name: ${userName}`,
      `Email: ${input.userEmail || "Anonymous"}`,
      `User ID: ${input.userId || "Unknown"}`,
      `Role: ${input.userRole || "Unknown"}`,
      `User Agent: ${input.userAgent || "Unknown"}`,
    ].join("\n");

    const deliveries = await Promise.all(
      recipients.map((recipient) =>
        postWebhook({
          type: "notification.email",
          eventType: "feedback.submitted",
          to: recipient,
          subject,
          title: subject,
          message: details,
          metadata: {
            feedbackAction: "user_feedback",
            category,
            source: input.source || "Unknown",
            pageUrl: input.pageUrl || "",
            userEmail: input.userEmail || "Anonymous",
            userId: input.userId || "Unknown",
            userName,
            userRole: input.userRole || "Unknown",
          },
        }),
      ),
    );

    return {
      ok: deliveries.every((d) => d.ok),
      status: deliveries.find((d) => !d.ok)?.status ?? 200,
      data: {
        recipients,
        deliveries: deliveries.map((d, i) => ({
          recipient: recipients[i],
          ok: d.ok,
          status: d.status,
          data: d.data,
        })),
      },
    };
  },

  async sendRaw(input: EmailPayload): Promise<EmailResult> {
    return postWebhook({
      type: "notification.email",
      eventType: input.eventType,
      to: input.to,
      subject: input.subject,
      title: input.subject,
      message: input.message,
      actionUrl: input.actionUrl ?? "",
      code: input.code ?? "",
      requestId: input.requestId ?? "",
      taskId: input.taskId ?? "",
      userName: input.userName ?? "",
      metadata: input.metadata ?? {},
    });
  },
};
