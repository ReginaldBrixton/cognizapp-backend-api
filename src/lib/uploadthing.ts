import { randomUUID } from "node:crypto";

import { UTApi } from "uploadthing/server";

import { env } from "../config/env";

let client: UTApi | null = null;

function getUploadThingClient() {
  if (!env.uploadthingToken) {
    return null;
  }

  client ??= new UTApi({
    token: env.uploadthingToken,
    logFormat: env.isProduction ? "json" : "pretty",
    logLevel: "Error",
  });

  return client;
}

export function uploadthingConfigured() {
  return Boolean(env.uploadthingToken);
}

export async function checkUploadThingHealth() {
  const utapi = getUploadThingClient();
  if (!utapi) {
    return {
      configured: false,
      healthy: false,
      message: "UploadThing token is not configured",
    };
  }

  try {
    const usage = await utapi.getUsageInfo();
    return {
      configured: true,
      healthy: true,
      usage: {
        filesUploaded: usage.filesUploaded,
        totalBytes: usage.totalBytes,
        limitBytes: usage.limitBytes,
      },
      message: "UploadThing API is reachable",
    };
  } catch (error) {
    return {
      configured: true,
      healthy: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export type SupportUploadResult =
  | {
      ok: true;
      key: string;
      url: string;
      name: string;
      size: number;
      customId: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      data?: unknown;
    };

function normalizeMimeType(value: string) {
  const normalized = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized || "application/octet-stream";
}

export async function uploadSupportFile(input: {
  bytes: Buffer;
  fileName: string;
  fileType: string;
  requestId?: string | null;
  userId: string;
  purpose: string;
  metadata?: Record<string, unknown>;
}): Promise<SupportUploadResult> {
  const utapi = getUploadThingClient();
  if (!utapi) {
    return {
      ok: false,
      code: "uploadthing_not_configured",
      message: "UploadThing token is not configured",
    };
  }

  const safePurpose = input.purpose.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const fileType = normalizeMimeType(input.fileType);
  // UploadThing stores customId in its own database with a practical length limit.
  // Keep ownership linkage in our support_files row and use a compact external id.
  const customId = ["support", safePurpose, randomUUID()].join(":");

  const arrayBuffer = input.bytes.buffer.slice(
    input.bytes.byteOffset,
    input.bytes.byteOffset + input.bytes.byteLength,
  ) as ArrayBuffer;

  const file = new File([arrayBuffer], input.fileName, {
    type: fileType,
  }) as File & { customId?: string };
  file.customId = customId;

  const result = await utapi.uploadFiles(file, {
    contentDisposition: "attachment",
  });

  if (result.error || !result.data) {
    return {
      ok: false,
      code: result.error?.code ?? "uploadthing_upload_failed",
      message: result.error?.message ?? "UploadThing upload failed",
      data: result.error?.data,
    };
  }

  return {
    ok: true,
    key: result.data.key,
    url: (result.data as { ufsUrl?: string }).ufsUrl || `https://utfs.io/f/${result.data.key}`,
    name: result.data.name,
    size: result.data.size,
    customId,
  };
}
