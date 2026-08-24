import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ArbError } from "../core/errors.js";
import { SessionRepository, UserRepository } from "../db/repositories.js";
import { hashPassword, verifyPassword } from "./password.js";
export const credentialsSchema = z.object({
    email: z.string().email().max(254),
    // Length is the property that actually matters; arbitrary character classes
    // mostly push people toward predictable substitutions.
    password: z.string().min(10).max(200),
});
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export class PasswordAuthProvider {
    kind = "password";
    users;
    sessions;
    ttlMs;
    clock;
    emailVerificationRequired;
    constructor(db, options = {}) {
        this.users = new UserRepository(db);
        this.sessions = new SessionRepository(db);
        this.ttlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
        this.clock = options.clock ?? Date.now;
        this.emailVerificationRequired = options.emailVerificationRequired ?? false;
    }
    async signUp(email, password) {
        const existing = await this.users.findByEmail(email);
        if (existing) {
            // Deliberately explicit: sign-up already reveals whether an email is
            // taken (you cannot create the account), so a vague message would add
            // no privacy while making the form unusable.
            throw new ArbError("VALIDATION_ERROR", "An account with that email already exists", 409);
        }
        const user = await this.users.create(email, await hashPassword(password), this.emailVerificationRequired ? null : this.clock());
        return this.issueSession(user);
    }
    async signIn(email, password) {
        const record = await this.users.findByEmail(email);
        if (!record) {
            // Hash anyway so a missing account and a wrong password take similar
            // time, and do not leak which emails are registered.
            await verifyPassword(password, "scrypt$65536$8$1$AAAA$AAAA");
            throw new ArbError("UNAUTHORIZED", "Email or password is incorrect", 401);
        }
        if (!(await verifyPassword(password, record.passwordHash))) {
            throw new ArbError("UNAUTHORIZED", "Email or password is incorrect", 401);
        }
        return this.issueSession(record);
    }
    async signOut(token) {
        await this.sessions.delete(token);
    }
    async verify(token) {
        if (!token)
            return null;
        const user = await this.sessions.findValidUser(token, this.clock());
        return user ? this.toAuthenticatedUser(user) : null;
    }
    async issueTrustedSessionForUserId(userId) {
        const user = await this.users.findById(userId);
        return user ? this.issueSession(user) : null;
    }
    async issueSession(user) {
        // 256 bits of entropy: not guessable, and opaque so it carries no claims
        // that could be tampered with.
        const token = randomBytes(32).toString("base64url");
        const expiresAtMs = this.clock() + this.ttlMs;
        await this.sessions.create(token, user.id, expiresAtMs);
        return { user: this.toAuthenticatedUser(user), token, expiresAtMs };
    }
    toAuthenticatedUser(user) {
        return { id: user.id, email: user.email, emailVerified: user.emailVerifiedAtMs !== null };
    }
}
