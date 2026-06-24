import { randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

import { getDb } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import { canAccessFullProtectedPreview } from "./payment-policy";

type PreviewAssetType = "limited_preview" | "full_protected_preview";
const ALLOWED_PREVIEW_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PREVIEW_IMAGE_FILES = 60;
const MAX_PREVIEW_IMAGE_BYTES = 15 * 1024 * 1024;

export function isPreviewImageFile(file: File) {
  const type = String(file.type ?? "").toLowerCase();
  const name = String(file.name ?? "").toLowerCase();
  return (
    ALLOWED_PREVIEW_IMAGE_TYPES.has(type) ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".png") ||
    name.endsWith(".webp")
  );
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "preview.pdf";
}

async function convertToPdf(source: Record<string, any>) {
  const bytes = Buffer.from(String(source.content_base64 ?? ""), "base64");
  if (!bytes.length) throw new HttpError(422, "source_file_empty", "The clean source file is empty");
  const type = String(source.file_type ?? "").toLowerCase();
  const name = String(source.file_name ?? "source");
  if (type === "application/pdf" || name.toLowerCase().endsWith(".pdf")) return bytes;
  throw new HttpError(
    422,
    "pdf_preview_source_required",
    "Upload a clean PDF preview source together with the final DOCX file",
  );
}

async function watermarkPdf(
  sourceBytes: Uint8Array,
  watermarkLines: string[],
  limitedPages?: number,
) {
  const source = await PDFDocument.load(sourceBytes);
  const pageCount = source.getPageCount();
  const output = await PDFDocument.create();
  const selectedCount = limitedPages ? Math.min(limitedPages, pageCount) : pageCount;
  const copied = await output.copyPages(
    source,
    Array.from({ length: selectedCount }, (_, index) => index),
  );
  copied.forEach((page) => output.addPage(page));
  const font = await output.embedFont(StandardFonts.HelveticaBold);
  const text = watermarkLines.join(" | ");

  for (const page of output.getPages()) {
    const { width, height } = page.getSize();
    page.drawText(text, {
      x: Math.max(20, width * 0.08),
      y: height * 0.48,
      size: Math.max(10, Math.min(18, width / 34)),
      font,
      color: rgb(0.72, 0.08, 0.08),
      opacity: 0.28,
      rotate: degrees(32),
      maxWidth: width * 0.84,
    });
    page.drawText("CogniZap protected preview - payment required to unlock clean files", {
      x: 24,
      y: 18,
      size: 8,
      font,
      color: rgb(0.45, 0.08, 0.08),
      opacity: 0.75,
      maxWidth: width - 48,
    });
  }

  return {
    bytes: Buffer.from(await output.save()),
    pageCount: selectedCount,
    sourcePageCount: pageCount,
  };
}

async function upsertAsset(input: {
  requestId: string;
  sourceFileId: string;
  assetType: PreviewAssetType;
  accessTier: "free" | "payment_required";
  status: "pending" | "processing" | "ready" | "failed";
  conversionJobId: string;
  fileId?: string | null;
  pageCount?: number | null;
  sourcePageCount?: number | null;
  watermarkMetadata?: Record<string, unknown>;
  errorMessage?: string | null;
}) {
  const db = getDb();
  const [asset] = await db`
    INSERT INTO support_preview_assets (
      request_id, source_file_id, file_id, asset_type, generation_status, access_tier,
      conversion_job_id, page_count, source_page_count, watermark_metadata,
      error_message, published_at
    )
    VALUES (
      ${input.requestId}::uuid, ${input.sourceFileId}::uuid, ${input.fileId ?? null}::uuid,
      ${input.assetType}, ${input.status}, ${input.accessTier}, ${input.conversionJobId},
      ${input.pageCount ?? null}, ${input.sourcePageCount ?? null},
      ${db.json((input.watermarkMetadata ?? {}) as any)}, ${input.errorMessage ?? null},
      ${input.status === "ready" ? new Date() : null}
    )
    ON CONFLICT (request_id, asset_type)
    DO UPDATE SET
      source_file_id = EXCLUDED.source_file_id,
      file_id = EXCLUDED.file_id,
      generation_status = EXCLUDED.generation_status,
      access_tier = EXCLUDED.access_tier,
      conversion_job_id = EXCLUDED.conversion_job_id,
      page_count = EXCLUDED.page_count,
      source_page_count = EXCLUDED.source_page_count,
      watermark_metadata = EXCLUDED.watermark_metadata,
      error_message = EXCLUDED.error_message,
      published_at = EXCLUDED.published_at,
      updated_at = NOW()
    RETURNING *
  `;
  return asset;
}

export async function generateProtectedPreviews(requestId: string, sourceFileId: string) {
  const db = getDb();
  const [request] = await db`
    SELECT r.*, c.email, c.full_name
    FROM support_requests r
    LEFT JOIN support_clients c ON c.id = r.client_id
    WHERE r.id = ${requestId}::uuid
    LIMIT 1
  `;
  const [source] = await db`
    SELECT *
    FROM support_files
    WHERE id = ${sourceFileId}::uuid AND request_id = ${requestId}::uuid
    LIMIT 1
  `;
  if (!request || !source) throw new HttpError(404, "preview_source_not_found", "Preview source was not found");

  const jobId = randomUUID();
  await db`
    UPDATE support_requests
    SET preview_status = 'processing', preview_access = 'none', updated_at = NOW()
    WHERE id = ${requestId}::uuid
  `;
  for (const [assetType, accessTier] of [
    ["limited_preview", "free"],
    ["full_protected_preview", "payment_required"],
  ] as const) {
    await upsertAsset({
      requestId,
      sourceFileId,
      assetType,
      accessTier,
      status: "processing",
      conversionJobId: jobId,
    });
  }

  try {
    const converted = await convertToPdf(source);
    const timestamp = new Date().toISOString();
    const identity = String(request.full_name || request.email || request.user_key_id);
    const watermark = [identity, String(request.task_id ?? request.id), timestamp];
    const sourcePdf = await PDFDocument.load(converted);
    const totalPages = sourcePdf.getPageCount();
    const limitedPageCount = totalPages <= 5 ? Math.max(1, Math.ceil(totalPages * 0.4)) : Math.min(4, totalPages);
    const limited = await watermarkPdf(converted, watermark, limitedPageCount);
    const full = await watermarkPdf(converted, watermark);
    const generated = [
      { type: "limited_preview" as const, access: "free" as const, result: limited },
      { type: "full_protected_preview" as const, access: "payment_required" as const, result: full },
    ];

    const assets = [];
    for (const item of generated) {
      const fileName = safeFileName(`${request.task_id}-${item.type}.pdf`);
      const [file] = await db`
        INSERT INTO support_files (
          request_id, user_key_id, file_name, file_url, file_type, file_size,
          content_base64, purpose, storage_provider
        )
        VALUES (
          ${requestId}::uuid, ${request.user_key_id}, ${fileName}, '', 'application/pdf',
          ${item.result.bytes.length}, ${item.result.bytes.toString("base64")},
          ${item.type}, 'database'
        )
        RETURNING *
      `;
      const asset = await upsertAsset({
        requestId,
        sourceFileId,
        fileId: String(file.id),
        assetType: item.type,
        accessTier: item.access,
        status: "ready",
        conversionJobId: jobId,
        pageCount: item.result.pageCount,
        sourcePageCount: item.result.sourcePageCount,
        watermarkMetadata: {
          identity,
          requestId,
          taskId: request.task_id,
          generatedAt: timestamp,
          message: "CogniZap Preview - Payment Required to Unlock",
        },
      });
      assets.push(asset);
    }
    await db`
      UPDATE support_requests
      SET preview_status = 'ready', preview_access = 'limited', status = 'work_ready', updated_at = NOW()
      WHERE id = ${requestId}::uuid
    `;
    return assets;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db`
      UPDATE support_preview_assets
      SET generation_status = 'failed', error_message = ${message}, updated_at = NOW()
      WHERE request_id = ${requestId}::uuid
    `;
    await db`
      UPDATE support_requests
      SET preview_status = 'failed', preview_access = 'none', updated_at = NOW()
      WHERE id = ${requestId}::uuid
    `;
    throw error;
  }
}

export function redactPreviewAsset(row: Record<string, any>) {
  return {
    id: row.id,
    requestId: row.request_id,
    assetType: row.asset_type,
    generationStatus: row.generation_status,
    accessTier: row.access_tier,
    pageCount: row.page_count,
    sourcePageCount: row.source_page_count,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    canView: Boolean(row.can_view),
    contentUrl: row.can_view
      ? `/api/support/client/requests/${row.request_id}/previews/${row.id}/content`
      : null,
  };
}

export function assertPreviewAccess(row: Record<string, any>) {
  if (row.asset_type === "limited_preview") return;
  if (canAccessFullProtectedPreview(row.payment_status, row.payment_policy)) return;
  throw new HttpError(402, "PREVIEW_PAYMENT_REQUIRED", "Complete the required payment to unlock the full protected preview.");
}

export function redactPreviewPage(row: Record<string, any>) {
  return {
    id: row.id,
    requestId: row.request_id,
    pageNumber: Number(row.page_number ?? 0),
    generationStatus: row.generation_status,
    accessTier: row.access_tier,
    fileName: row.file_name,
    fileType: row.file_type,
    fileSize: row.file_size,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    canView: true,
    contentUrl: `/api/support/client/requests/${row.request_id}/preview-pages/${row.id}/content`,
  };
}

export function redactImagePreviewPackage(rows: Record<string, any>[]) {
  const pages = rows.map(redactPreviewPage);
  return {
    id: rows[0]?.request_id ? `preview-pages-${rows[0].request_id}` : "preview-pages",
    requestId: rows[0]?.request_id ?? null,
    assetType: "image_preview_pages",
    generationStatus: rows.every((row) => row.generation_status === "ready") ? "ready" : "processing",
    accessTier: "free",
    pageCount: pages.length,
    sourcePageCount: pages.length,
    publishedAt: rows[0]?.published_at ?? null,
    createdAt: rows[0]?.created_at ?? null,
    canView: true,
    contentUrl: null,
    pages,
  };
}

export async function storeImagePreviewPages(input: {
  requestId: string;
  userKeyId: string;
  previewImages: File[];
}) {
  if (input.previewImages.length === 0) {
    throw new HttpError(
      400,
      "preview_images_required",
      "Upload at least one PNG or JPEG preview page image.",
    );
  }
  if (input.previewImages.length > MAX_PREVIEW_IMAGE_FILES) {
    throw new HttpError(
      400,
      "too_many_preview_images",
      `Upload ${MAX_PREVIEW_IMAGE_FILES} preview images or fewer in one delivery package.`,
    );
  }

  const invalid = input.previewImages.find((file) => !isPreviewImageFile(file));
  if (invalid) {
    throw new HttpError(
      400,
      "invalid_preview_image",
      `${invalid.name} must be a PNG, JPG, JPEG, or WebP preview image.`,
    );
  }
  const tooLarge = input.previewImages.find((file) => Number(file.size ?? 0) > MAX_PREVIEW_IMAGE_BYTES);
  if (tooLarge) {
    throw new HttpError(
      413,
      "preview_image_too_large",
      `${tooLarge.name} is too large. Each preview page image must be 15 MB or smaller.`,
    );
  }

  const db = getDb();
  const preparedImages = await Promise.all(
    input.previewImages.map(async (file, index) => ({
      file,
      pageNumber: index + 1,
      contentBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
    })),
  );

  return db.begin(async (tx) => {
    await tx`DELETE FROM support_preview_pages WHERE request_id = ${input.requestId}::uuid`;
    await tx`
      DELETE FROM support_files
      WHERE request_id = ${input.requestId}::uuid
        AND purpose = 'provider_preview_page'
    `;

    const pages: Record<string, any>[] = [];
    for (const image of preparedImages) {
      const [storedFile] = await tx`
        INSERT INTO support_files (
          request_id, user_key_id, file_name, file_url, file_type, file_size,
          content_base64, purpose, storage_provider
        )
        VALUES (
          ${input.requestId}::uuid, ${input.userKeyId}, ${image.file.name}, '',
          ${image.file.type || "application/octet-stream"}, ${image.file.size},
          ${image.contentBase64}, 'provider_preview_page', 'database'
        )
        RETURNING *
      `;
      const [page] = await tx`
        INSERT INTO support_preview_pages (
          request_id, file_id, page_number, generation_status, access_tier, metadata
        )
        VALUES (
          ${input.requestId}::uuid, ${storedFile.id}, ${image.pageNumber}, 'ready', 'free',
          ${tx.json({
            originalFileName: image.file.name,
            fileType: image.file.type || "application/octet-stream",
            fileSize: image.file.size,
          })}
        )
        RETURNING *
      `;
      pages.push({ ...page, file_name: storedFile.file_name, file_type: storedFile.file_type, file_size: storedFile.file_size });
    }

    return pages;
  });
}
