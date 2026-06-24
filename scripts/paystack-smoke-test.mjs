import { readFileSync } from "node:fs";

const envText = readFileSync(".env", "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1).trim()];
    }),
);

if (!env.PAYSTACK_SECRET_KEY) {
  throw new Error("PAYSTACK_SECRET_KEY is required in users/.env");
}

const reference = `cz_smoke_${Date.now()}`;
const response = await fetch("https://api.paystack.co/transaction/initialize", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    email: "smoke-test@cognizapp.com",
    amount: 100,
    currency: "GHS",
    reference,
    callback_url: "https://www.cognizapp.com/settings/billing",
    metadata: {
      purpose: "smoke_test",
      source: "codex",
    },
  }),
});

const payload = await response.json().catch(() => ({}));
const authorizationUrl = payload.data?.authorization_url;

console.log(
  JSON.stringify(
    {
      httpStatus: response.status,
      status: payload.status,
      message: payload.message,
      mode: env.PAYSTACK_SECRET_KEY.startsWith("sk_live_") ? "live" : "test",
      hasAccessCode: Boolean(payload.data?.access_code),
      authorizationHost: authorizationUrl ? new URL(authorizationUrl).host : null,
      reference,
    },
    null,
    2,
  ),
);
