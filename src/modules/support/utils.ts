/**
 * Small utility helpers for the support module.
 */

export function isRequestBodyParseError(error: unknown) {
	if (error instanceof SyntaxError) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /json|parse|body/i.test(message) && /unexpected|invalid|malformed|syntax/i.test(message);
}
