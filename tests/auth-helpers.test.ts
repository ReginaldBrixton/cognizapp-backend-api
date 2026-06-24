import { describe, expect, it, mock, beforeAll } from "bun:test";

// Mock the env module before any imports that depend on it
mock.module("../src/config/env", () => ({
  env: {
    environment: "test",
    isDevelopment: true,
    isProduction: false,
    port: 4040,
    jwtAccessExpiryMinutes: 15,
    jwtRefreshExpiryDays: 30,
    jwtSecret: "test-secret-at-least-32-chars-long!!",
    jwtIssuer: "test",
    jwtAudience: "test",
    strictDeviceFingerprint: false,
  },
}));

// Mock the database and cache to avoid connection attempts
mock.module("../src/lib/db", () => ({
  getDb: () => () => Promise.resolve([]),
}));

mock.module("../src/lib/cache", () => ({
  cache: {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    deletePattern: () => Promise.resolve(),
  },
}));

mock.module("../src/lib/crypto", () => ({
  deviceFingerprint: (input: string) => `fp_${input}`,
  hashToken: (token: string) => `hash_${token}`,
  signAccessToken: () => Promise.resolve("mock-access-token"),
  signRefreshToken: () => Promise.resolve("mock-refresh-token"),
}));

mock.module("../src/modules/workspace/service", () => ({
  workspaceService: {
    ensureBootstrap: () => Promise.resolve(),
  },
}));

mock.module("../src/modules/auth/repository", () => ({
  authRepository: {
    createSession: () => Promise.resolve({ id: "mock-session" }),
    updateSessionTokens: () => Promise.resolve(),
    insertActivity: () => Promise.resolve(),
    revokeAllSessions: () => Promise.resolve(),
  },
}));

import {
  readHeader,
  normalizeEmail,
  getDeviceInfo,
  isLoopbackAddress,
  getClientIp,
} from "../src/modules/auth/helpers";

describe("readHeader", () => {
  it("reads from a Headers instance", () => {
    const headers = new Headers({ "content-type": "application/json" });
    expect(readHeader(headers, "content-type")).toBe("application/json");
  });

  it("reads from a plain object", () => {
    const headers = { "x-custom": "value" };
    expect(readHeader(headers, "x-custom")).toBe("value");
  });

  it("falls back to lowercase key lookup for plain objects", () => {
    const headers = { "x-forwarded-for": "1.2.3.4" };
    expect(readHeader(headers, "X-Forwarded-For")).toBe("1.2.3.4");
  });

  it('returns empty string for missing headers', () => {
    const headers = new Headers();
    expect(readHeader(headers, "x-missing")).toBe("");
  });

  it('returns empty string for undefined headers', () => {
    expect(readHeader(undefined, "x-missing")).toBe("");
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases email", () => {
    expect(normalizeEmail("  User@Example.COM  ")).toBe("user@example.com");
  });

  it("handles already normalized email", () => {
    expect(normalizeEmail("user@test.com")).toBe("user@test.com");
  });
});

describe("getDeviceInfo", () => {
  it("detects Chrome on Windows", () => {
    const info = getDeviceInfo(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    expect(info.browser).toBe("Chrome");
    expect(info.os).toBe("Windows");
    expect(info.type).toBe("desktop");
    expect(info.name).toBe("Chrome on Windows");
  });

  it("detects Edge on Windows", () => {
    const info = getDeviceInfo(
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0",
    );
    expect(info.browser).toBe("Edge");
    expect(info.os).toBe("Windows");
  });

  it("detects Firefox on Linux", () => {
    const info = getDeviceInfo("Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0");
    expect(info.browser).toBe("Firefox");
    expect(info.os).toBe("Linux");
    expect(info.type).toBe("desktop");
  });

  it("detects Safari on macOS", () => {
    const info = getDeviceInfo(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    );
    expect(info.browser).toBe("Safari");
    expect(info.os).toBe("macOS");
  });

  it("detects Android as mobile", () => {
    const info = getDeviceInfo(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    );
    expect(info.os).toBe("Android");
    expect(info.type).toBe("mobile");
  });

  it("detects iPhone UA (note: matched as macOS due to 'Mac OS' in UA string)", () => {
    const info = getDeviceInfo(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
    );
    // The 'mac os' check precedes the 'iphone' check in the else-if chain,
    // so iPhone UAs that include "Mac OS" are classified as macOS/desktop.
    expect(info.os).toBe("macOS");
    expect(info.type).toBe("desktop");
  });

  it('returns "Unknown Device" for unrecognized user agents', () => {
    const info = getDeviceInfo("some-random-bot/1.0");
    expect(info.name).toBe("Unknown Device");
    expect(info.browser).toBe("Unknown");
    expect(info.os).toBe("Unknown");
  });
});

describe("isLoopbackAddress", () => {
  it("recognizes IPv4 loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  });

  it("recognizes IPv6 loopback", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
  });

  it("recognizes IPv4-mapped IPv6 loopback", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects non-loopback addresses", () => {
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
  });
});

describe("getClientIp", () => {
  it("extracts IP from x-forwarded-for header", () => {
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(getClientIp(headers)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip", () => {
    const headers = new Headers({ "x-real-ip": "9.9.9.9" });
    expect(getClientIp(headers)).toBe("9.9.9.9");
  });

  it("returns fallback when no IP headers present", () => {
    const headers = new Headers();
    expect(getClientIp(headers, "default-ip")).toBe("default-ip");
  });

  it("returns fallback for undefined headers", () => {
    expect(getClientIp(undefined, "fallback")).toBe("fallback");
  });
});
