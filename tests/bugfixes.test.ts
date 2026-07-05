import { describe, expect, it } from "bun:test";

import { HttpError } from "../src/lib/errors";
import {
  buildPaymentSchedule,
  calculatePaymentAmount,
  paymentStatusForVerifiedPayment,
  roundMoney,
} from "../src/modules/support/shared/payments";

describe("buildPaymentSchedule deposit split", () => {
  it("defaults to 100% deposit when no depositPercent is provided", () => {
    const schedule = buildPaymentSchedule({
      serviceTags: ["data-analysis"],
      academicLevel: "master",
      deadlineAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      pages: 12,
    });
    expect(schedule.depositPercent).toBe(100);
    expect(schedule.depositAmount).toBe(schedule.paymentAmount);
    expect(schedule.balanceAmount).toBe(0);
  });

  it("splits deposit and balance when depositPercent is provided", () => {
    const total = calculatePaymentAmount({
      serviceTags: ["data-analysis"],
      academicLevel: "master",
      deadlineAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      pages: 12,
    });
    const schedule = buildPaymentSchedule(
      {
        serviceTags: ["data-analysis"],
        academicLevel: "master",
        deadlineAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        pages: 12,
      },
      40,
    );
    expect(schedule.depositPercent).toBe(40);
    expect(schedule.paymentAmount).toBe(roundMoney(total));
    expect(schedule.depositAmount).toBe(roundMoney((total * 40) / 100));
    expect(schedule.balanceAmount).toBe(roundMoney(total - schedule.depositAmount));
    expect(roundMoney(schedule.depositAmount + schedule.balanceAmount)).toBe(
      roundMoney(total),
    );
  });

  it("clamps depositPercent to [0, 100]", () => {
    const body = { serviceTags: ["data-analysis"] };
    const total = calculatePaymentAmount(body);

    const zero = buildPaymentSchedule(body, 0);
    expect(zero.depositPercent).toBe(0);
    expect(zero.depositAmount).toBe(0);
    expect(zero.balanceAmount).toBe(roundMoney(total));

    const over = buildPaymentSchedule(body, 150);
    expect(over.depositPercent).toBe(100);
    expect(over.depositAmount).toBe(roundMoney(total));
    expect(over.balanceAmount).toBe(0);
  });

  it("handles NaN depositPercent by falling back to 100%", () => {
    const body = { serviceTags: ["data-analysis"] };
    const schedule = buildPaymentSchedule(body, Number.NaN);
    expect(schedule.depositPercent).toBe(100);
  });

  it("handles zero payment amount", () => {
    const schedule = buildPaymentSchedule(
      { serviceTags: [], costEstimate: { total: 0 } },
      40,
    );
    expect(schedule.paymentAmount).toBe(0);
    expect(schedule.depositAmount).toBe(0);
    expect(schedule.balanceAmount).toBe(0);
  });
});

describe("paymentStatusForVerifiedPayment explicit types", () => {
  it("returns deposit_paid for deposit", () => {
    expect(paymentStatusForVerifiedPayment("deposit")).toBe("deposit_paid");
  });

  it("returns final_payment_required for partial_balance", () => {
    expect(paymentStatusForVerifiedPayment("partial_balance")).toBe(
      "final_payment_required",
    );
  });

  it("returns paid for final_balance", () => {
    expect(paymentStatusForVerifiedPayment("final_balance")).toBe("paid");
  });

  it("returns paid for full_payment", () => {
    expect(paymentStatusForVerifiedPayment("full_payment")).toBe("paid");
  });

  it("throws HttpError 400 for unknown payment type", () => {
    expect(() => paymentStatusForVerifiedPayment("unknown_type")).toThrow(
      HttpError,
    );
    try {
      paymentStatusForVerifiedPayment("unknown_type");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe("invalid_payment_type");
    }
  });
});
