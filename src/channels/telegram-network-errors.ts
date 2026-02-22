/**
 * Telegram network error classifier.
 *
 * Classifies errors as recoverable (transient network) vs permanent (API).
 * Used by the polling restart loop and getFile retry logic.
 */

const RECOVERABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ECONNABORTED",
  "ERR_NETWORK",
]);

const RECOVERABLE_ERROR_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
]);

const RECOVERABLE_MESSAGE_SNIPPETS = [
  "fetch failed",
  "typeerror: fetch failed",
  "undici",
  "network error",
  "network request",
  "client network socket disconnected",
  "socket hang up",
  "getaddrinfo",
  "timeout",
  "timed out",
];

const FILE_TOO_BIG_RE = /file is too big/i;

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === "string") return errno;
  return undefined;
}

function getErrorName(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  return "name" in err ? String((err as { name: unknown }).name) : "";
}

function formatErrorMessage(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Walk the error chain: err -> err.cause -> err.reason -> err.errors[].
 * Grammy's HttpError wraps the underlying fetch error in .error (not .cause),
 * so we follow that too, but only for HttpError to avoid widening the search.
 */
function collectErrorCandidates(err: unknown): unknown[] {
  const queue = [err];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    candidates.push(current);

    if (typeof current === "object") {
      const cause = (current as { cause?: unknown }).cause;
      if (cause && !seen.has(cause)) queue.push(cause);

      const reason = (current as { reason?: unknown }).reason;
      if (reason && !seen.has(reason)) queue.push(reason);

      const errors = (current as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const nested of errors) {
          if (nested && !seen.has(nested)) queue.push(nested);
        }
      }

      // Grammy HttpError wraps the real network error in .error
      if (getErrorName(current) === "HttpError") {
        const wrapped = (current as { error?: unknown }).error;
        if (wrapped && !seen.has(wrapped)) queue.push(wrapped);
      }
    }
  }

  return candidates;
}

export type TelegramNetworkErrorContext = "polling" | "send" | "getfile" | "unknown";

/**
 * True if the error is a transient network error worth retrying. False for
 * permanent API errors (4xx). Message-based matching is disabled for "send"
 * context to avoid suppressing real delivery errors.
 */
export function isRecoverableTelegramNetworkError(
  err: unknown,
  options: { context?: TelegramNetworkErrorContext; allowMessageMatch?: boolean } = {},
): boolean {
  if (!err) return false;

  const allowMessageMatch =
    typeof options.allowMessageMatch === "boolean"
      ? options.allowMessageMatch
      : options.context !== "send";

  for (const candidate of collectErrorCandidates(err)) {
    const code = getErrorCode(candidate)?.trim().toUpperCase();
    if (code && RECOVERABLE_ERROR_CODES.has(code)) return true;

    const name = getErrorName(candidate);
    if (name && RECOVERABLE_ERROR_NAMES.has(name)) return true;

    if (allowMessageMatch) {
      const message = formatErrorMessage(candidate).toLowerCase();
      if (message && RECOVERABLE_MESSAGE_SNIPPETS.some((s) => message.includes(s))) return true;
    }
  }

  return false;
}

/**
 * Returns true for Telegram's permanent "file is too big" error (>20 MB).
 * This is a 400 Bad Request and should never be retried.
 */
export function isFileTooBigError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const description = (err as { description?: unknown }).description;
  if (typeof description === "string" && FILE_TOO_BIG_RE.test(description)) return true;
  return FILE_TOO_BIG_RE.test(formatErrorMessage(err));
}

/**
 * Returns true if a getFile error is worth retrying (i.e. it is NOT a
 * permanent "file is too big" error and IS a recoverable network error).
 */
export function isRetryableGetFileError(err: unknown): boolean {
  if (isFileTooBigError(err)) return false;
  return isRecoverableTelegramNetworkError(err, { context: "getfile" });
}
