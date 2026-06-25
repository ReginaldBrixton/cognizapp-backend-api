import { emailService } from "./email-service";

type NotificationEmailInput = {
  to: string;
  userId: string;
  eventType: string;
  title: string;
  message: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
};

export const n8nService = {
  isEmailConfigured() {
    return emailService.isConfigured();
  },

  async sendNotificationEmail(input: NotificationEmailInput) {
    return emailService.sendRaw({
      to: input.to,
      eventType: input.eventType,
      subject: input.title,
      message: input.message,
      actionUrl: input.actionUrl,
      metadata: input.metadata,
    });
  },
};
