/**
 * Support notification helpers (email + WhatsApp).
 */

import { n8nService } from "../../../lib/n8n";
import {
	sendWhatsAppNotification,
	wahaWhatsAppConfigured as twilioWhatsAppConfigured,
} from "../../../lib/waha-whatsapp";
import { notificationsRepository } from "../../notifications/repository";
import type { AuthContext } from "../../auth/middleware";

export async function sendSupportEmail(
	to: string,
	userId: string,
	eventType: string,
	title: string,
	message: string,
	metadata: Record<string, any> = {},
) {
	if (!to.trim()) {
		return { ok: false, status: 0, data: { skipped: true, reason: "missing_recipient" } };
	}
	const result = await n8nService.sendNotificationEmail({
		to,
		userId,
		eventType,
		title,
		message,
		actionUrl: String(metadata.actionUrl ?? ""),
		metadata,
	});
	if (!result.ok && !result.data.skipped) {
		console.warn("[support:n8n] email webhook failed", {
			eventType,
			userId,
			status: result.status,
			plainEnglishMeaning:
				"The support action succeeded, but the notification email webhook did not accept the message.",
			details: result.data,
		});
	} else if (result.ok) {
		const [name = "", domain = ""] = to.split("@");
		console.log("[support:n8n] email webhook accepted", {
			eventType,
			userId,
			recipient: `${name.slice(0, 2)}***@${domain}`,
			status: result.status,
			plainEnglishMeaning:
				"The notification email webhook accepted this support message.",
		});
	}
	return result;
}

export async function sendSupportWhatsApp(
	to: string,
	userId: string,
	eventType: string,
	title: string,
	message: string,
	metadata: Record<string, any> = {},
) {
	const result = await sendWhatsAppNotification({
		to,
		eventType,
		title,
		message,
		actionUrl: String(metadata.actionUrl ?? ""),
		metadata,
	});
	if (!result.ok && !result.skipped) {
		console.warn("[support:twilio] WhatsApp notification failed", {
			eventType,
			userId,
			status: result.status,
			plainEnglishMeaning:
				"The support action succeeded, but Twilio did not accept the WhatsApp notification.",
			details: result.error ?? result.data,
		});
	} else if (result.ok) {
		console.log("[support:twilio] WhatsApp notification accepted", {
			eventType,
			userId,
			sid: result.sid,
			status: result.messageStatus,
			plainEnglishMeaning: "Twilio accepted this WhatsApp support notification.",
		});
	} else if (result.skipped && twilioWhatsAppConfigured()) {
		console.warn("[support:twilio] WhatsApp notification skipped", {
			eventType,
			userId,
			details: result.data,
		});
	}
	return result;
}

export async function createSupportNotification(
	userId: string,
	auth: AuthContext,
	title: string,
	body: string,
	metadata: Record<string, any>,
) {
	await notificationsRepository.insert({
		userId,
		type: "support.payment",
		category: "support",
		title,
		body,
		actorId: auth.userId,
		actorType: auth.actorType,
		actorKey: auth.userId,
		metadata,
	});
}
