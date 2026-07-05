/**
 * Delivery access and redaction policy helpers.
 *
 * These functions determine whether a client can download/preview a delivery
 * and redact sensitive file URLs when access is not allowed.
 */

import { HttpError } from "../../lib/errors";
import { toCamel } from "./shared";
import { DELIVERY_PAYMENT_REQUIRED_MESSAGE } from "./constants";

export function isPreviewSupportDelivery(delivery: Record<string, any>) {
	return (
		["preview", "partial"].includes(String(delivery.delivery_type ?? "")) ||
		delivery.preview_allowed === true
	);
}

export function isSupersededSupportDelivery(delivery: Record<string, any>) {
	const metadata = delivery.metadata;
	if (!metadata) return false;
	if (typeof metadata === "string") {
		try {
			const parsed = JSON.parse(metadata) as Record<string, any>;
			return Boolean(parsed.supersededAt || parsed.superseded_at);
		} catch {
			return false;
		}
	}
	return Boolean(metadata.supersededAt || metadata.superseded_at);
}

export function canDownloadSupportDelivery(delivery: Record<string, any>) {
	if (isSupersededSupportDelivery(delivery)) return false;
	if (isPreviewSupportDelivery(delivery)) return true;
	const deliveryStatus = String(delivery.delivery_status ?? "");
	return (
		String(delivery.payment_status ?? "") === "paid" &&
		["download_unlocked", "downloaded"].includes(deliveryStatus) &&
		delivery.is_locked !== true
	);
}

export function assertSupportDeliveryDownloadAllowed(delivery: Record<string, any>) {
	if (canDownloadSupportDelivery(delivery)) return;
	throw new HttpError(402, "PAYMENT_REQUIRED", DELIVERY_PAYMENT_REQUIRED_MESSAGE);
}

export function redactClientDelivery(row: Record<string, any>) {
	const canDownload = canDownloadSupportDelivery(row);
	const delivery = toCamel(row) as Record<string, any>;
	delivery.canDownload = canDownload;
	delivery.canPreview = isPreviewSupportDelivery(row);
	delivery.downloadUrl = canDownload
		? `/api/support/client/requests/${row.request_id}/download?deliveryId=${row.id}`
		: null;

	if (!canDownload) {
		delivery.fileUrl = null;
		delivery.externalFileId = null;
		delivery.externalFileUrl = null;
		delivery.externalFolderId = null;
		delivery.externalUploadStatus = null;
		delivery.externalUploadedAt = null;
	}

	return delivery;
}

export function decodePreviewImageContent(row: Record<string, any>) {
	const raw = String(row.content_base64 ?? "").trim();
	if (!raw) {
		throw new HttpError(422, "preview_page_content_missing", "Preview page image is not available yet");
	}

	const bytes = Buffer.from(raw, "base64");
	if (bytes.length < 8) {
		throw new HttpError(422, "preview_page_content_invalid", "Preview page image is incomplete");
	}

	const fileType = String(row.file_type || "image/png").toLowerCase();
	const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
	const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
	const isWebp =
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP";
	if (!isPng && !isJpeg && !isWebp) {
		throw new HttpError(422, "preview_page_content_invalid", "Preview page content is not an image");
	}

	const mime = isPng ? "image/png" : isJpeg ? "image/jpeg" : isWebp ? "image/webp" : fileType;
	return { bytes, mime };
}
