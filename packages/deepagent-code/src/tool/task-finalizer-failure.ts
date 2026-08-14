export function decodeFinalizerFailure(message: string) {
  const sourceCode = message.match(/^\[([^\]]+)\]/)?.[1]
  const attempts = Number(message.match(/Attempts: ([12])\./)?.[1] ?? 1)
  const failureClass =
    sourceCode === "structured_output_invalid" || sourceCode === "structured_output_missing"
      ? "validation"
      : sourceCode
        ? "transport"
        : "internal"
  const reason =
    failureClass === "validation"
      ? "structured_finalizer_validation_error"
      : failureClass === "transport"
        ? "structured_finalizer_transport_error"
        : "structured_finalizer_internal_error"
  return {
    reason,
    attempts,
    error: {
      code: reason,
      message,
      data: {
        phase: "finalize",
        attempt: attempts,
        failure_class: failureClass,
        ...(sourceCode ? { source_code: sourceCode } : {}),
      },
    },
  } as const
}
