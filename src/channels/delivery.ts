export type DeliveryFailureOutcome = "not_sent" | "unknown";

export interface DeliveryErrorOptions {
  outcome: DeliveryFailureOutcome;
  retryable: boolean;
  cause?: unknown;
}

/** Error type for channel sends where delivery state matters. */
export class DeliveryError extends Error {
  readonly outcome: DeliveryFailureOutcome;
  readonly retryable: boolean;

  constructor(message: string, options: DeliveryErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "DeliveryError";
    this.outcome = options.outcome;
    this.retryable = options.retryable;
  }
}

export function isDeliveryError(error: unknown): error is DeliveryError {
  return error instanceof DeliveryError;
}

export function isUnknownDeliveryError(error: unknown): boolean {
  return isDeliveryError(error) && error.outcome === "unknown";
}

export function isRetryableNotSentDeliveryError(error: unknown): boolean {
  return isDeliveryError(error) && error.outcome === "not_sent" && error.retryable;
}

export function deliveryNotSent(message: string, options: { retryable: boolean; cause?: unknown }): DeliveryError {
  return new DeliveryError(message, {
    outcome: "not_sent",
    retryable: options.retryable,
    cause: options.cause,
  });
}

export function deliveryUnknown(message: string, options: { retryable?: boolean; cause?: unknown } = {}): DeliveryError {
  let retryable = false;
  if (typeof options.retryable === "boolean") {
    retryable = options.retryable;
  }
  return new DeliveryError(message, {
    outcome: "unknown",
    retryable,
    cause: options.cause,
  });
}

export function safeDeliveryErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }
  return String(error).slice(0, 500);
}

export function ensureDeliveryError(error: unknown): DeliveryError {
  if (isDeliveryError(error)) {
    return error;
  }
  return deliveryUnknown(safeDeliveryErrorMessage(error), { cause: error });
}
