import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
// promisify resolves to the 3-argument overload, which drops the cost
// parameters, so the signature is stated explicitly.
const scrypt = promisify(scryptCallback);
/**
 * Password hashing with Node's built-in scrypt.
 *
 * scrypt is memory-hard: brute-forcing it needs RAM per guess, not just CPU,
 * which is what makes GPU cracking expensive. Chosen over argon2 here only
 * because it ships in Node — no native module, so nothing can fail to compile
 * on a serverless build.
 *
 * Stored format: scrypt$N$r$p$saltB64$hashB64
 * The parameters travel with the hash, so cost can be raised later without
 * invalidating existing passwords.
 */
const PARAMS = { N: 2 ** 16, r: 8, p: 1, keyLength: 64 };
const MAXMEM = 256 * 1024 * 1024;
export async function hashPassword(plain) {
    const salt = randomBytes(16);
    const derived = (await scrypt(plain, salt, PARAMS.keyLength, {
        N: PARAMS.N,
        r: PARAMS.r,
        p: PARAMS.p,
        maxmem: MAXMEM,
    }));
    return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}
/** Constant-time verification. Never throws on malformed input — returns false. */
export async function verifyPassword(plain, stored) {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt")
        return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p))
        return false;
    let salt;
    let expected;
    try {
        salt = Buffer.from(parts[4], "base64");
        expected = Buffer.from(parts[5], "base64");
    }
    catch {
        return false;
    }
    let derived;
    try {
        derived = (await scrypt(plain, salt, expected.length, { N, r, p, maxmem: MAXMEM }));
    }
    catch {
        return false;
    }
    // Length check first: timingSafeEqual throws on a mismatch.
    if (derived.length !== expected.length)
        return false;
    return timingSafeEqual(derived, expected);
}
