import { emailService } from "./email-service";

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
  magicLinkUrl?: string;
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

export const emailDelivery = {
  isConfigured() {
    return emailService.isConfigured();
  },

  async sendOtpEmail(input: OtpEmailInput): Promise<DeliveryResult> {
    return emailService.sendOtp(input);
  },

  async sendFeedbackEmail(input: FeedbackEmailInput): Promise<DeliveryResult> {
    return emailService.sendFeedback(input);
  },
};
