/** Error taxonomy (ARB-001/ARB-005). Every failure maps to one code the iOS client can render. */
export class ArbError extends Error {
    code;
    httpStatus;
    details;
    constructor(code, message, httpStatus = 400, details) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
        this.name = "ArbError";
    }
}
export function asArbError(err) {
    if (err instanceof ArbError)
        return err;
    if (err instanceof Error && err.name === "AbortError") {
        return new ArbError("PROVIDER_TIMEOUT", "Quote provider timed out", 504);
    }
    return new ArbError("INTERNAL_ERROR", "Unexpected internal error", 500);
}
