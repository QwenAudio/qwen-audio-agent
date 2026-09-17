export function toolFailure(errorCode, userMessage, {
  retryable = false,
  status = 'failed',
  ...details
} = {}) {
  return {
    status,
    error: true,
    error_code: errorCode,
    user_message: userMessage,
    retryable,
    ...details,
  }
}
