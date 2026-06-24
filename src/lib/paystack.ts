import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../config/env";
import { HttpError } from "./errors";

type PaystackResponse<T = Record<string, unknown>> = {
  status: boolean;
  message: string;
  data?: T;
};

type MobileMoneyProvider = "mtn" | "atl" | "vod";
type TransferRecipientType = "mobile_money" | "ghipss" | "authorization";

function assertConfigured() {
  if (!env.paystackSecretKey) {
    throw new HttpError(
      500,
      "paystack_not_configured",
      "Paystack secret key is not configured",
    );
  }
}

function toMinorUnits(amount: number) {
  return Math.round(amount * 100);
}

function normalizeProvider(provider: string): MobileMoneyProvider {
  const value = provider
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (["mtn", "mtnmomo", "mtnmobilemoney"].includes(value)) {
    return "mtn";
  }
  if (
    [
      "atl",
      "airteltigo",
      "airteltigomoney",
      "atmoney",
      "airteltigoatmoney",
      "airteltigocash",
    ].includes(value)
  ) {
    return "atl";
  }
  if (
    ["telecel", "telecelcash", "vod", "vodafone", "vodafonecash"].includes(
      value,
    )
  ) {
    return "vod";
  }
  throw new HttpError(
    400,
    "unsupported_mobile_money_provider",
    "Use MTN Mobile Money, AirtelTigo Money, or Telecel Cash",
  );
}

function normalizeMobileMoneyPhone(phone: string) {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00233")) {
    digits = digits.slice(5);
  }
  if (digits.startsWith("233")) {
    digits = digits.slice(3);
  }
  if (digits.length === 9 && !digits.startsWith("0")) {
    digits = `0${digits}`;
  }
  return digits.slice(0, 10);
}

function hashMobileMoneyPhone(phone: string) {
  const normalized = normalizeMobileMoneyPhone(phone);
  if (normalized.length < 9) {
    return "";
  }
  return createHmac("sha256", env.jwtSecret)
    .update(`mobile-money:${normalized}`)
    .digest("hex");
}

async function requestPaystack<T>(
  path: string,
  init?: RequestInit,
): Promise<PaystackResponse<T>> {
  assertConfigured();
  const response = await fetch(`${env.paystackBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response
    .json()
    .catch(() => ({}))) as PaystackResponse<T>;
  if (!response.ok || payload.status === false) {
    const status = response.ok ? 502 : response.status || 502;
    throw new HttpError(
      status,
      "paystack_request_failed",
      payload.message || "Paystack request failed",
      payload,
    );
  }
  return payload;
}

export const paystackService = {
  getMode() {
    if (!env.paystackSecretKey) {
      return "not_configured";
    }
    if (env.paystackSecretKey.startsWith("sk_live_")) {
      return "live";
    }
    if (env.paystackSecretKey.startsWith("sk_test_")) {
      return "test";
    }
    return "unknown";
  },

  normalizeProvider,
  normalizeMobileMoneyPhone,
  hashMobileMoneyPhone,

  createReference(requestId: string) {
    const suffix = Math.random().toString(36).slice(2, 8);
    return `cz_${requestId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}_${Date.now()}_${suffix}`;
  },

  async initializeCheckout(input: {
    email: string;
    amount: number;
    currency: string;
    reference: string;
    plan?: string;
    channels?: Array<
      "card" | "bank" | "ussd" | "qr" | "mobile_money" | "bank_transfer" | "eft"
    >;
    callbackUrl?: string;
    metadata?: Record<string, unknown>;
  }) {
    return requestPaystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        amount: toMinorUnits(input.amount),
        currency: input.currency,
        reference: input.reference,
        plan: input.plan,
        channels: input.channels,
        callback_url: input.callbackUrl,
        metadata: input.metadata ?? {},
      }),
    });
  },

  async createPlan(input: {
    name: string;
    amount: number;
    currency: string;
    interval: "monthly" | "annually";
    description?: string;
  }) {
    return requestPaystack("/plan", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        amount: toMinorUnits(input.amount),
        currency: input.currency,
        interval: input.interval,
        description: input.description,
      }),
    });
  },

  async chargeMobileMoney(input: {
    email: string;
    amount: number;
    currency: string;
    phone: string;
    provider: string;
    reference: string;
    metadata?: Record<string, unknown>;
  }) {
    return requestPaystack("/charge", {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        amount: toMinorUnits(input.amount),
        currency: input.currency,
        mobile_money: {
          phone: input.phone,
          provider: normalizeProvider(input.provider),
        },
        reference: input.reference,
        metadata: input.metadata ?? {},
      }),
    });
  },

  async verifyTransaction(reference: string) {
    return requestPaystack(
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
  },

  async disableSubscription(input: { code: string; token: string }) {
    return requestPaystack("/subscription/disable", {
      method: "POST",
      body: JSON.stringify({
        code: input.code,
        token: input.token,
      }),
    });
  },

  async checkCharge(reference: string) {
    return requestPaystack(`/charge/${encodeURIComponent(reference)}`);
  },

  async submitOtp(input: { reference: string; otp: string }) {
    return requestPaystack("/charge/submit_otp", {
      method: "POST",
      body: JSON.stringify({
        reference: input.reference,
        otp: input.otp,
      }),
    });
  },

  async submitPin(input: { reference: string; pin: string }) {
    return requestPaystack("/charge/submit_pin", {
      method: "POST",
      body: JSON.stringify({
        reference: input.reference,
        pin: input.pin,
      }),
    });
  },

  async listTransferBanks(input: {
    currency?: string;
    type?: "mobile_money" | "ghipss";
  } = {}) {
    const params = new URLSearchParams();
    if (input.currency) params.set("currency", input.currency);
    if (input.type) params.set("type", input.type);
    const query = params.toString();
    return requestPaystack<Array<Record<string, unknown>>>(
      `/bank${query ? `?${query}` : ""}`,
      { method: "GET" },
    );
  },

  async createTransferRecipient(input: {
    type: TransferRecipientType;
    name: string;
    accountNumber?: string;
    bankCode?: string;
    currency: string;
    authorizationCode?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }) {
    const body: Record<string, unknown> = {
      type: input.type,
      name: input.name,
      currency: input.currency,
      description: input.description,
      metadata: input.metadata ?? {},
    };
    if (input.type === "authorization") {
      body.authorization_code = input.authorizationCode;
    } else {
      body.account_number = input.accountNumber;
      body.bank_code = input.bankCode;
    }
    return requestPaystack<Record<string, unknown>>("/transferrecipient", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  async initiateTransfer(input: {
    amount: number;
    currency: string;
    recipient: string;
    reference: string;
    reason?: string;
  }) {
    return requestPaystack<Record<string, unknown>>("/transfer", {
      method: "POST",
      body: JSON.stringify({
        source: "balance",
        amount: toMinorUnits(input.amount),
        currency: input.currency,
        recipient: input.recipient,
        reference: input.reference,
        reason: input.reason,
      }),
    });
  },

  verifyWebhookSignature(rawBody: string, signature: string) {
    assertConfigured();
    const expected = createHmac("sha512", env.paystackSecretKey)
      .update(rawBody)
      .digest("hex");
    try {
      const expectedBuffer = Buffer.from(expected, "hex");
      const signatureBuffer = Buffer.from(signature, "hex");
      return (
        expectedBuffer.length === signatureBuffer.length &&
        timingSafeEqual(expectedBuffer, signatureBuffer)
      );
    } catch {
      return false;
    }
  },

  async createRefund(input: {
    reference: string;
    amount?: number;
    currency?: string;
    customerNote?: string;
    merchantNote?: string;
  }) {
    const body: Record<string, unknown> = {
      transaction: input.reference,
    };
    if (input.amount !== undefined) {
      body.amount = toMinorUnits(input.amount);
    }
    if (input.currency) {
      body.currency = input.currency;
    }
    if (input.customerNote) {
      body.customer_note = input.customerNote;
    }
    if (input.merchantNote) {
      body.merchant_note = input.merchantNote;
    }
    return requestPaystack("/refund", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  async getRefundStatus(reference: string) {
    return requestPaystack(`/refund/${encodeURIComponent(reference)}`);
  },
};
