const CANONICAL_PRODUCTION_ORIGIN = "https://www.cognizapp.com";
const ALLOWED_PRODUCTION_CALLBACK_ORIGINS = new Set([
  CANONICAL_PRODUCTION_ORIGIN,
  "https://cognizapp.com",
]);

function parseOrigin(value: string | undefined) {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

export function getPublicSiteOrigin() {
  const explicitOrigin =
    parseOrigin(process.env.PUBLIC_SITE_URL) ||
    parseOrigin(process.env.FRONTEND_URL);

  if (isProductionRuntime()) {
    if (explicitOrigin && ALLOWED_PRODUCTION_CALLBACK_ORIGINS.has(explicitOrigin)) {
      return explicitOrigin;
    }
    return CANONICAL_PRODUCTION_ORIGIN;
  }

  if (explicitOrigin) return explicitOrigin;

  return (
    parseOrigin(process.env.NEXT_PUBLIC_FRONTEND_PRODUCTION_URL) ||
    parseOrigin(process.env.NEXT_PUBLIC_FRONTEND_URL) ||
    "http://localhost:3000"
  );
}

export function normalizePublicCallbackUrl(callbackUrl: string | undefined) {
  const publicOrigin = getPublicSiteOrigin();
  const fallback = new URL("/", publicOrigin);

  if (!callbackUrl?.trim()) {
    return fallback.toString();
  }

  try {
    const url = new URL(callbackUrl.trim(), publicOrigin);
    if (isProductionRuntime()) {
      if (ALLOWED_PRODUCTION_CALLBACK_ORIGINS.has(url.origin)) {
        return url.toString();
      }
      const origin = new URL(publicOrigin);
      url.protocol = origin.protocol;
      url.host = origin.host;
    }
    return url.toString();
  } catch {
    return fallback.toString();
  }
}

function isProductionRuntime() {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL === "1" ||
    process.env.ENVIRONMENT === "production"
  );
}
