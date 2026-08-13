import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ArbError } from "../core/errors.js";
import type { SqlClient } from "../db/client.js";
import { SessionRepository, UserRepository, type UserRecord } from "../db/repositories.js";
import { hashPassword, verifyPassword } from "./password.js";

/**
 * Authentication: proving who someone is.
 *
 * Authorization — what that person is allowed to touch — is enforced
 * separately, in the repositories and route handlers, by scoping every query
 * to the user id derived from the verified session. Being signed in never
 * implies access to a given portfolio.
 *
 * The AuthProvider interface exists so a managed provider (Clerk, Supabase)
 * could replace this implementation later by verifying their token and
 * returning the same AuthenticatedUser. Routes would not change.
 */

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export interface AuthSession {
  user: AuthenticatedUser;
  /** Raw token. Sent to the client as an httpOnly cookie and never logged. */
  token: string;
  expiresAtMs: number;
}

export interface AuthProvider {
  readonly kind: string;
  signUp(email: string, password: string): Promise<AuthSession>;
  signIn(email: string, password: string): Promise<AuthSession>;
  signOut(token: string): Promise<void>;
  verify(token: string): Promise<AuthenticatedUser | null>;
}

export const credentialsSchema = z.object({
  email: z.string().email().max(254),
  // Length is the property that actually matters; arbitrary character classes
  // mostly push people toward predictable substitutions.
  password: z.string().min(10).max(200),
});

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface PasswordAuthOptions {
  sessionTtlMs?: number;
  clock?: () => number;
}

export class PasswordAuthProvider implements AuthProvider {
  readonly kind = "password";
  private readonly users: UserRepository;
  private readonly sessions: SessionRepository;
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(db: SqlClient, options: PasswordAuthOptions = {}) {
    this.users = new UserRepository(db);
    this.sessions = new SessionRepository(db);
    this.ttlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.clock = options.clock ?? Date.now;
  }

  async signUp(email: string, password: string): Promise<AuthSession> {
    const existing = await this.users.findByEmail(email);
    if (existing) {
      // Deliberately explicit: sign-up already reveals whether an email is
      // taken (you cannot create the account), so a vague message would add
      // no privacy while making the form unusable.
      throw new ArbError("VALIDATION_ERROR", "An account with that email already exists", 409);
    }
    const user = await this.users.create(email, await hashPassword(password));
    return this.issueSession(user);
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
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

  async signOut(token: string): Promise<void> {
    await this.sessions.delete(token);
  }

  async verify(token: string): Promise<AuthenticatedUser | null> {
    if (!token) return null;
    const user = await this.sessions.findValidUser(token, this.clock());
    return user ? { id: user.id, email: user.email } : null;
  }

  private async issueSession(user: UserRecord): Promise<AuthSession> {
    // 256 bits of entropy: not guessable, and opaque so it carries no claims
    // that could be tampered with.
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = this.clock() + this.ttlMs;
    await this.sessions.create(token, user.id, expiresAtMs);
    return { user: { id: user.id, email: user.email }, token, expiresAtMs };
  }
}
