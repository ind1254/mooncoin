/** Error taxonomy (ARB-001/ARB-005). Every failure maps to one code the iOS client can render. */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "TOKEN_NOT_ALLOWED"
  | "VENUE_NOT_ALLOWED"
  | "AMOUNT_OUT_OF_RANGE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ERROR"
  | "PROVIDER_RATE_LIMITED"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "INSUFFICIENT_VENUES"
  | "STALE_QUOTE"
  | "INTERNAL_ERROR"
  // Paper-trading engine
  | "INSUFFICIENT_PAPER_BALANCE"
  | "NO_QUOTE_AVAILABLE"
  | "PRICE_IMPACT_TOO_HIGH"
  | "POSITION_NOT_FOUND"
  | "POSITION_ALREADY_CLOSED"
  | "PAPER_TRADE_INELIGIBLE"
  | "POSITION_LIMIT_REACHED"
  /** No live quote could be obtained. Never substituted with a simulated one. */
  | "QUOTE_UNAVAILABLE"
  // Identity and access
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "ORIGIN_NOT_ALLOWED"
  | "RATE_LIMITED"
  | "DATABASE_ERROR";

export class ArbError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus: number = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ArbError";
  }
}

export function asArbError(err: unknown): ArbError {
  if (err instanceof ArbError) return err;
  if (err instanceof Error && err.name === "AbortError") {
    return new ArbError("PROVIDER_TIMEOUT", "Quote provider timed out", 504);
  }
  return new ArbError("INTERNAL_ERROR", "Unexpected internal error", 500);
}
