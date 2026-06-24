/**
 * Background submission queue using Redis
 * Handles request submissions asynchronously
 */

import { cache } from "./cache"

export interface QueuedSubmission {
	requestId: string
	userId: string
	timestamp: number
	retryCount: number
}

const QUEUE_KEY_PREFIX = "submission-queue"
const MAX_RETRIES = 5
const PROCESSING_TIMEOUT_MS = 60000 // 1 minute

/**
 * Add a submission to the queue
 */
export async function enqueueSubmission(requestId: string, userId: string): Promise<void> {
	const submission: QueuedSubmission = {
		requestId,
		userId,
		timestamp: Date.now(),
		retryCount: 0,
	}
	
	const queueKey = `${QUEUE_KEY_PREFIX}:pending`
	await cache.setJson(queueKey, submission, 3600) // 1 hour TTL
	
	console.info(`[SubmissionQueue] Enqueued submission for request ${requestId}`)
}

/**
 * Get the next pending submission
 */
export async function getNextSubmission(): Promise<QueuedSubmission | null> {
	const queueKey = `${QUEUE_KEY_PREFIX}:pending`
	return await cache.getJson<QueuedSubmission>(queueKey)
}

/**
 * Mark a submission as processing
 */
export async function markProcessing(requestId: string): Promise<void> {
	const processingKey = `${QUEUE_KEY_PREFIX}:processing:${requestId}`
	await cache.setJson(processingKey, { timestamp: Date.now() }, PROCESSING_TIMEOUT_MS / 1000)
}

/**
 * Mark a submission as completed
 */
export async function markCompleted(requestId: string): Promise<void> {
	const queueKey = `${QUEUE_KEY_PREFIX}:pending`
	const processingKey = `${QUEUE_KEY_PREFIX}:processing:${requestId}`
	
	// Clear from queue
	await cache.deletePattern(`${queueKey}*`)
	await cache.deletePattern(`${processingKey}*`)
	
	console.info(`[SubmissionQueue] Completed submission for request ${requestId}`)
}

/**
 * Mark a submission as failed
 */
export async function markFailed(requestId: string, error: string): Promise<void> {
	const failedKey = `${QUEUE_KEY_PREFIX}:failed:${requestId}`
	await cache.setJson(failedKey, { error, timestamp: Date.now() }, 86400) // 24 hours
	
	console.error(`[SubmissionQueue] Failed submission for request ${requestId}:`, error)
}

/**
 * Check if a submission is being processed
 */
export async function isProcessing(requestId: string): Promise<boolean> {
	const processingKey = `${QUEUE_KEY_PREFIX}:processing:${requestId}`
	const processing = await cache.getJson<{ timestamp: number }>(processingKey)
	
	if (!processing) return false
	
	// Check if processing has timed out
	if (Date.now() - processing.timestamp > PROCESSING_TIMEOUT_MS) {
		await cache.deletePattern(`${processingKey}*`)
		return false
	}
	
	return true
}
