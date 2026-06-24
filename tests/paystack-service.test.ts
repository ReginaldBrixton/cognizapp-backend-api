import { describe, expect, test } from "bun:test";

import { paystackService } from "../src/lib/paystack";

describe("paystack service", () => {
  test("normalizes Ghana mobile money provider labels", () => {
    expect(paystackService.normalizeProvider("MTN Mobile Money")).toBe("mtn");
    expect(paystackService.normalizeProvider("AirtelTigo Money")).toBe("atl");
    expect(paystackService.normalizeProvider("ATMoney")).toBe("atl");
    expect(paystackService.normalizeProvider("Telecel Cash")).toBe("vod");
    expect(paystackService.normalizeProvider("Vodafone Cash")).toBe("vod");
  });

  test("rejects unsupported mobile money providers", () => {
    expect(() => paystackService.normalizeProvider("unknown wallet")).toThrow(
      "Use MTN Mobile Money, AirtelTigo Money, or Telecel Cash",
    );
  });

  test("normalizes Ghana mobile money phone numbers before matching retries", () => {
    expect(paystackService.normalizeMobileMoneyPhone("0591099003")).toBe("0591099003");
    expect(paystackService.normalizeMobileMoneyPhone("+233 591 099 003")).toBe("0591099003");
    expect(paystackService.normalizeMobileMoneyPhone("233591099003")).toBe("0591099003");
    expect(paystackService.normalizeMobileMoneyPhone("591099003")).toBe("0591099003");
  });

  test("hashes equivalent mobile money phone formats to the same non-raw value", () => {
    const localHash = paystackService.hashMobileMoneyPhone("0591099003");
    expect(localHash).toBe(paystackService.hashMobileMoneyPhone("+233 591 099 003"));
    expect(localHash).not.toContain("0591099003");
    expect(localHash).toHaveLength(64);
  });
});
