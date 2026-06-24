import { describe, expect, test } from "bun:test";

import { HttpError } from "../src/lib/errors";
import {
  assertPreviewAccess,
  redactImagePreviewPackage,
  redactPreviewPage,
  redactPreviewAsset,
} from "../src/modules/support/preview-service";

describe("protected preview access", () => {
  test("limited previews are available without payment", () => {
    expect(() =>
      assertPreviewAccess({
        asset_type: "limited_preview",
        payment_status: "unpaid",
      }),
    ).not.toThrow();
  });

  test("full previews return a consistent 402 payment gate", () => {
    try {
      assertPreviewAccess({
        asset_type: "full_protected_preview",
        payment_status: "unpaid",
        payment_policy: { previewUnlock: "deposit" },
      });
      throw new Error("Expected preview access to be denied");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(402);
      expect((error as HttpError).code).toBe("PREVIEW_PAYMENT_REQUIRED");
    }
  });

  test("redacted metadata never exposes storage records or clean bytes", () => {
    const hidden = redactPreviewAsset({
      id: "asset-1",
      request_id: "request-1",
      file_id: "protected-file-id",
      source_file_id: "clean-source-id",
      content_base64: "clean-bytes",
      asset_type: "full_protected_preview",
      generation_status: "ready",
      access_tier: "payment_required",
      can_view: false,
    });

    expect(hidden.contentUrl).toBeNull();
    expect(hidden).not.toHaveProperty("fileId");
    expect(hidden).not.toHaveProperty("sourceFileId");
    expect(hidden).not.toHaveProperty("contentBase64");
  });

  test("authorized metadata points only to the protected content endpoint", () => {
    const visible = redactPreviewAsset({
      id: "asset-2",
      request_id: "request-2",
      file_id: "protected-file-id",
      source_file_id: "clean-source-id",
      asset_type: "full_protected_preview",
      generation_status: "ready",
      access_tier: "payment_required",
      can_view: true,
    });

    expect(visible.contentUrl).toBe(
      "/api/support/client/requests/request-2/previews/asset-2/content",
    );
    expect(visible.contentUrl).not.toContain("protected-file-id");
    expect(visible.contentUrl).not.toContain("clean-source-id");
  });

  test("image preview package exposes ordered page content endpoints without clean file ids", () => {
    const packagePreview = redactImagePreviewPackage([
      {
        id: "page-1",
        request_id: "request-3",
        file_id: "clean-file-hidden",
        page_number: 1,
        generation_status: "ready",
        access_tier: "free",
        file_name: "page-1.png",
        file_type: "image/png",
        file_size: 1200,
        published_at: "2026-06-15T00:00:00.000Z",
        created_at: "2026-06-15T00:00:00.000Z",
      },
      {
        id: "page-2",
        request_id: "request-3",
        file_id: "clean-file-hidden-2",
        page_number: 2,
        generation_status: "ready",
        access_tier: "free",
        file_name: "page-2.png",
        file_type: "image/png",
        file_size: 1300,
        published_at: "2026-06-15T00:00:01.000Z",
        created_at: "2026-06-15T00:00:01.000Z",
      },
    ]);

    expect(packagePreview.assetType).toBe("image_preview_pages");
    expect(packagePreview.pageCount).toBe(2);
    expect(packagePreview.contentUrl).toBeNull();
    expect(packagePreview.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(packagePreview.pages[0].contentUrl).toBe(
      "/api/support/client/requests/request-3/preview-pages/page-1/content",
    );
    expect(packagePreview.pages[0]).not.toHaveProperty("fileId");
  });

  test("single image preview page redaction never exposes the support file id", () => {
    const page = redactPreviewPage({
      id: "page-4",
      request_id: "request-4",
      file_id: "hidden-file-id",
      page_number: 4,
      generation_status: "ready",
      access_tier: "free",
      file_name: "page-4.jpg",
      file_type: "image/jpeg",
    });

    expect(page.contentUrl).toBe(
      "/api/support/client/requests/request-4/preview-pages/page-4/content",
    );
    expect(page).not.toHaveProperty("fileId");
  });
});
