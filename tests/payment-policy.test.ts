import { describe, expect, test } from "bun:test";

import {
  buildSupportPaymentPolicy,
  canAccessFullProtectedPreview,
  paymentProgressStatus,
} from "../src/modules/support/payment-policy";

describe("support payment policy", () => {
  test("uses the tiered deposit matrix for longer work", () => {
    const request = {
      service_category: "full_project",
      pages: 20,
      word_count: 7000,
      priority: "normal",
    };

    expect(buildSupportPaymentPolicy(request, "first_time").depositPercent).toBe(40);
    expect(buildSupportPaymentPolicy(request, "trusted").depositPercent).toBe(25);
    expect(buildSupportPaymentPolicy(request, "high_risk").depositPercent).toBe(60);
  });

  test("requires full payment for short work", () => {
    const policy = buildSupportPaymentPolicy(
      {
        service_category: "assignment",
        pages: 5,
        word_count: 1400,
        priority: "normal",
      },
      "trusted",
    );

    expect(policy.depositPercent).toBe(100);
    expect(policy.previewUnlock).toBe("full_payment");
    expect(policy.revisionsAllowed).toBe(2);
  });

  test("requires payment before urgent work starts", () => {
    const policy = buildSupportPaymentPolicy(
      {
        service_category: "data_analysis",
        pages: 12,
        word_count: 4000,
        priority: "urgent",
      },
      "high_risk",
    );

    expect(policy.depositPercent).toBe(60);
    expect(policy.workStartRequirement).toBe("deposit");
  });

  test("unlocks protected previews only at the policy threshold", () => {
    expect(canAccessFullProtectedPreview("unpaid", { previewUnlock: "deposit" })).toBe(false);
    expect(canAccessFullProtectedPreview("deposit_paid", { previewUnlock: "deposit" })).toBe(true);
    expect(canAccessFullProtectedPreview("final_payment_pending_verification", { previewUnlock: "deposit" })).toBe(true);
    expect(canAccessFullProtectedPreview("deposit_paid", { previewUnlock: "full_payment" })).toBe(false);
    expect(canAccessFullProtectedPreview("paid", { previewUnlock: "full_payment" })).toBe(true);
  });

  test("derives unlock state from cumulative verified amounts", () => {
    expect(paymentProgressStatus({ totalAmount: 1000, depositAmount: 400, verifiedAmount: 399 })).toBe("unpaid");
    expect(paymentProgressStatus({ totalAmount: 1000, depositAmount: 400, verifiedAmount: 400 })).toBe("deposit_paid");
    expect(paymentProgressStatus({ totalAmount: 1000, depositAmount: 400, verifiedAmount: 999 })).toBe("deposit_paid");
    expect(paymentProgressStatus({ totalAmount: 1000, depositAmount: 400, verifiedAmount: 1000 })).toBe("paid");
  });
});
