export function ok(data: Record<string, unknown> = {}) {
  return {
    success: true,
    ...data,
  };
}

export function fail(message: string, code: string, details?: unknown) {
  return {
    success: false,
    error: message,
    errorCode: code,
    details,
  };
}
