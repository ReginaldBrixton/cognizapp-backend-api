import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { getPublicSiteOrigin, normalizePublicCallbackUrl } from "../src/lib/site-url";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.PUBLIC_SITE_URL;
  delete process.env.FRONTEND_URL;
  delete process.env.NEXT_PUBLIC_FRONTEND_PRODUCTION_URL;
  delete process.env.NEXT_PUBLIC_FRONTEND_URL;
  delete process.env.NODE_ENV;
  delete process.env.VERCEL;
  delete process.env.ENVIRONMENT;
});

afterAll(() => {
  process.env = originalEnv;
});

describe("getPublicSiteOrigin", () => {
  it("returns canonical origin in production", () => {
    process.env.NODE_ENV = "production";
    expect(getPublicSiteOrigin()).toBe("https://www.cognizapp.com");
  });

  it("returns configured origin in production if it matches allowed list", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_SITE_URL = "https://cognizapp.com";
    expect(getPublicSiteOrigin()).toBe("https://cognizapp.com");
  });

  it("falls back to canonical in production for non-allowed origin", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_SITE_URL = "https://evil.com";
    expect(getPublicSiteOrigin()).toBe("https://www.cognizapp.com");
  });

  it("returns explicit origin in development", () => {
    process.env.NODE_ENV = "development";
    process.env.PUBLIC_SITE_URL = "http://localhost:3000";
    expect(getPublicSiteOrigin()).toBe("http://localhost:3000");
  });

  it("falls back to localhost:3000 in development with no env vars", () => {
    process.env.NODE_ENV = "development";
    expect(getPublicSiteOrigin()).toBe("http://localhost:3000");
  });

  it("recognizes VERCEL=1 as production runtime", () => {
    process.env.VERCEL = "1";
    expect(getPublicSiteOrigin()).toBe("https://www.cognizapp.com");
  });
});

describe("normalizePublicCallbackUrl", () => {
  it("returns root URL for empty callback", () => {
    process.env.NODE_ENV = "development";
    const result = normalizePublicCallbackUrl("");
    expect(result).toContain("/");
  });

  it("returns root URL for undefined callback", () => {
    process.env.NODE_ENV = "development";
    const result = normalizePublicCallbackUrl(undefined);
    expect(result).toContain("/");
  });

  it("returns the callback URL unchanged in development", () => {
    process.env.NODE_ENV = "development";
    process.env.PUBLIC_SITE_URL = "http://localhost:3000";
    const result = normalizePublicCallbackUrl("http://localhost:3000/dashboard");
    expect(result).toBe("http://localhost:3000/dashboard");
  });

  it("rewrites non-allowed origins to canonical in production", () => {
    process.env.NODE_ENV = "production";
    const result = normalizePublicCallbackUrl("https://evil.com/callback");
    expect(result).toContain("www.cognizapp.com");
    expect(result).toContain("/callback");
  });

  it("allows known production origins in production", () => {
    process.env.NODE_ENV = "production";
    const result = normalizePublicCallbackUrl("https://cognizapp.com/dashboard");
    expect(result).toBe("https://cognizapp.com/dashboard");
  });

  it("returns fallback for malformed URLs", () => {
    process.env.NODE_ENV = "development";
    process.env.PUBLIC_SITE_URL = "http://localhost:3000";
    const result = normalizePublicCallbackUrl("://not-a-url");
    expect(result).toContain("localhost:3000");
  });
});
