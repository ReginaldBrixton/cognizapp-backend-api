/**
 * AI acknowledgement helper extracted from routes.ts.
 *
 * Creates an AI-generated first-response message in the support thread
 * when a client submits a request.
 */

import { getDb } from "../../lib/db";
import {
	generateSupportAiResponse,
	getPublicSupportAiModelName,
	getSupportAiModel,
	hashSupportPrompt,
} from "../../lib/gemini";
import type { AuthContext } from "../auth/middleware";
import { estimateSupportCost } from "./cost-estimation";
import { ensureSupportMessageThread, toCamel } from "./shared";
import { formatRequestDeadline, requestEstimateInput } from "./request-helpers";

export async function createRequestAiAcknowledgement(
	request: Record<string, any>,
	auth: AuthContext,
) {
	const db = getDb();
	const thread = await ensureSupportMessageThread(String(request.id), auth.userId);
	if (!thread) return null;

	const files = await db`
    SELECT id, file_name, file_type, file_size, purpose, content_base64, external_file_url
    FROM support_files
    WHERE request_id = ${request.id}::uuid
      AND user_key_id = ${auth.userId}
    ORDER BY created_at ASC
    LIMIT 8
  `;
	const attachmentMetadata = Array.isArray(request.attachment_metadata)
		? request.attachment_metadata
		: [];
	const fileReferences = [
		...attachmentMetadata,
		...files.map((file) => ({
			id: String(file.id),
			fileName: String(file.file_name ?? ""),
			fileType: String(file.file_type ?? ""),
			fileSize: Number(file.file_size ?? 0),
			purpose: String(file.purpose ?? "client_upload"),
			readableByModel: Boolean(file.content_base64),
			externalFileUrl: file.external_file_url ?? null,
		})),
	];
	const inlineFiles = files
		.filter((file) => file.content_base64 && Number(file.file_size ?? 0) <= 8 * 1024 * 1024)
		.slice(0, 4)
		.map((file) => ({
			mimeType: String(file.file_type ?? "application/octet-stream"),
			data: String(file.content_base64),
			displayName: String(file.file_name ?? "support-upload"),
		}));
	const costEstimate = await estimateSupportCost(requestEstimateInput(request));
	const promptHash = hashSupportPrompt({
		purpose: "support_request_acknowledgement",
		requestId: String(request.id),
		status: String(request.status ?? ""),
		model: getSupportAiModel(),
	});

	const [existing] = await db`
    SELECT id
    FROM support_messages
    WHERE thread_id = ${thread.id}::uuid
      AND sender_key_id = 'support-ai'
      AND prompt_hash = ${promptHash}
    LIMIT 1
  `;
	if (existing) return toCamel(existing);

	const prompt = [
		"Create a concise first support chat acknowledgement for a submitted client request.",
		"Speak directly to the client in first person plural as CognizApp Support.",
		"Explicitly say whether files/documents were read or only file names/metadata were available.",
		"Only claim document contents were read when readableFileCount is greater than 0.",
		"When readableFileCount is greater than 0, include 2-3 concrete observations from the readable file content and what needs to be done next.",
		"When only file metadata is available, list the uploaded file names/types and explain that deeper content review is continuing.",
		"If the request title or description contains console errors, stack traces, or code frames, do not quote them; treat them as accidental diagnostic text and focus on the client's actual files and support deliverable.",
		"Mention the deadline, the main deliverables you understand, and that a provider will follow up if human clarification or quoting is needed.",
		"Do not promise impossible work, final acceptance, or guaranteed delivery before payment/provider review.",
		JSON.stringify({
			request: {
				id: String(request.id),
				taskId: String(request.task_id ?? ""),
				title: String(request.title ?? ""),
				description: String(request.description ?? ""),
				serviceTags: Array.isArray(request.service_tags) ? request.service_tags : [],
				academicLevel: request.academic_level ?? null,
				subject: request.subject ?? null,
				outputExpectation: request.output_expectation ?? null,
				deadline: formatRequestDeadline(request.deadline_at),
				wordCount: request.word_count ?? null,
				pages: request.pages ?? null,
				budgetMin: request.budget_min ?? null,
				budgetMax: request.budget_max ?? null,
				currency: request.currency ?? "GHS",
				paymentStatus: request.payment_status ?? null,
			},
			costEstimate,
			fileReferences,
			readableFileCount: inlineFiles.length,
		}),
	].join("\n");

	const localAcknowledgement = () => {
		const fileNames = fileReferences
			.map((file: any) => String(file.fileName ?? file.name ?? file.displayName ?? "").trim())
			.filter(Boolean)
			.slice(0, 4);
		const title = String(request.title ?? "your request").trim();
		const safeTitle = /##\s*Error|Code Frame|RequestWizard|Draft not found|Console Error/i.test(
			title,
		)
			? "your submitted request"
			: `"${title || "your request"}"`;
		const filePhrase = fileReferences.length
			? inlineFiles.length
				? `I have reviewed readable document content from ${fileNames.length ? fileNames.join(", ") : "your uploaded files"}`
				: `I can see the uploaded file details for ${fileNames.length ? fileNames.join(", ") : "your files"} while deeper content review continues`
			: "I have reviewed your request details";
		const nextSteps =
			"We will compare the submitted material against the requested deliverables, confirm any missing context, and prepare the provider handoff before work begins";
		return {
			model: getSupportAiModel(),
			provider: "fallback" as const,
			reasoning:
				"The acknowledgement used the local request, file metadata, and cost-estimate context because CognizApp Lite was not available.",
			response: `${filePhrase}. For ${safeTitle}, ${nextSteps}. The current deadline is ${formatRequestDeadline(request.deadline_at)}.`,
			complexity: "complex" as const,
			actionItems: [
				{
					type: "contact_support" as const,
					label: "Wait for provider review",
					data: { requestId: String(request.id), taskId: String(request.task_id ?? "") },
				},
			],
		};
	};
	const generatedAiResult = await generateSupportAiResponse({
		prompt,
		requestReferences: [{ requestId: String(request.id), taskId: String(request.task_id ?? "") }],
		fileReferences,
		inlineFiles,
	}).catch((error) => {
		console.warn("[support:ai] request acknowledgement generation failed", {
			requestId: request.id,
			message: error instanceof Error ? error.message : String(error),
		});
		return localAcknowledgement();
	});
	const aiResult =
		generatedAiResult.provider === "fallback" ? localAcknowledgement() : generatedAiResult;
	const publicAiResult = {
		reasoning: aiResult.reasoning,
		response: aiResult.response,
		complexity: aiResult.complexity,
		actionItems: aiResult.actionItems,
		model: getPublicSupportAiModelName(aiResult.model),
		provider: aiResult.provider === "fallback" ? "fallback" : "cognizapp",
		costEstimate,
		readableFileCount: inlineFiles.length,
	};
	const [message] = await db`
    INSERT INTO support_messages (
      thread_id, sender_key_id, sender_name, sender_role, content, attachments, read_by,
      mentions, file_references, ai_reasoning, prompt_hash, structured_output
    )
    VALUES (
      ${thread.id}::uuid, 'support-ai', 'CognizApp AI', 'ai', ${aiResult.response}, '[]'::jsonb, ARRAY[]::TEXT[],
      ${db.json([{ requestId: String(request.id), taskId: String(request.task_id ?? "") }] as any)},
      ${db.json(fileReferences as any)}, ${aiResult.reasoning}, ${promptHash},
      ${db.json(publicAiResult as any)}
    )
    RETURNING *
  `;
	await db`
    UPDATE support_message_threads
    SET last_message_at = ${message.created_at}, updated_at = NOW()
    WHERE id = ${thread.id}
  `;
	const { broadcastSupportMessage } = await import("../support-messages/realtime");
	broadcastSupportMessage(String(thread.id), toCamel(message));
	return toCamel(message);
}
