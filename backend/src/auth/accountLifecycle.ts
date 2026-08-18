import { randomBytes } from "node:crypto";
import { ArbError } from "../core/errors.js";
import type { SqlClient } from "../db/client.js";
import {
  AccountActionTokenRepository,
  UserRepository,
  type UserRecord,
} from "../db/repositories.js";
import { hashPassword } from "./password.js";

export interface AccountEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export interface AccountEmailSender {
  readonly kind: string;
  send(message: AccountEmail): Promise<void>;
}

export interface ResendEmailSenderOptions {
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
}

/** Minimal Resend adapter; the key and sender stay server-side. */
export class ResendEmailSender implements AccountEmailSender {
  readonly kind = "resend";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ResendEmailSenderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: AccountEmail): Promise<void> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 8_000);
    try {
      const response = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        signal: abort.signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });
      if (!response.ok) {
        // Provider bodies can contain account/configuration detail, so retain
        // only the status in application errors and logs.
        throw new Error(`Email delivery failed with status ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface AccountLifecycleOptions {
  sender?: AccountEmailSender;
  appBaseUrl: string;
  clock?: () => number;
  verificationTtlMs?: number;
  resetTtlMs?: number;
}

export interface DeliveryResult {
  sent: boolean;
  reason?: "already_verified" | "delivery_unconfigured";
}

const VERIFY_TTL_MS = 24 * 60 * 60 * 1_000;
const RESET_TTL_MS = 60 * 60 * 1_000;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

function actionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Email verification and recovery orchestration. Links carry secrets in the
 * URL fragment so reverse proxies and ordinary HTTP request logs never see
 * them; the SPA POSTs the token after it loads.
 */
export class AccountLifecycleService {
  private readonly users: UserRepository;
  private readonly actions: AccountActionTokenRepository;
  private readonly sender: AccountEmailSender | undefined;
  private readonly appBaseUrl: string;
  private readonly clock: () => number;
  private readonly verificationTtlMs: number;
  private readonly resetTtlMs: number;

  constructor(db: SqlClient, options: AccountLifecycleOptions) {
    this.users = new UserRepository(db);
    this.actions = new AccountActionTokenRepository(db);
    this.sender = options.sender;
    this.appBaseUrl = new URL(options.appBaseUrl).origin;
    this.clock = options.clock ?? Date.now;
    this.verificationTtlMs = options.verificationTtlMs ?? VERIFY_TTL_MS;
    this.resetTtlMs = options.resetTtlMs ?? RESET_TTL_MS;
  }

  get deliveryConfigured(): boolean {
    return this.sender !== undefined;
  }

  get deliveryKind(): string | null {
    return this.sender?.kind ?? null;
  }

  async sendVerification(userId: string): Promise<DeliveryResult> {
    const user = await this.users.findById(userId);
    if (!user) throw new ArbError("UNAUTHORIZED", "Account not found", 401);
    if (user.emailVerifiedAtMs !== null) return { sent: false, reason: "already_verified" };
    if (!this.sender) return { sent: false, reason: "delivery_unconfigured" };

    const rawToken = actionToken();
    const now = this.clock();
    const actionId = await this.actions.issue(
      user.id,
      "verify_email",
      rawToken,
      now,
      now + this.verificationTtlMs,
    );
    const link = `${this.appBaseUrl}/#/verify-email/${rawToken}`;
    await this.sender.send({
      to: user.email,
      subject: "Verify your Moonpaper email",
      text: `Verify your Moonpaper email: ${link}\n\nThis link expires in 24 hours. Moonpaper is paper trading only.`,
      html: emailHtml(
        "Verify your email",
        `Confirm ${escapeHtml(user.email)} to protect your Moonpaper paper-trading account.`,
        "Verify email",
        link,
        "This link expires in 24 hours. Moonpaper never asks for a wallet or private key.",
      ),
      idempotencyKey: `moonpaper-verify-${actionId}`,
    });
    return { sent: true };
  }

  async verifyEmail(rawToken: string): Promise<UserRecord> {
    const user = await this.actions.verifyEmail(rawToken, this.clock());
    if (!user) throw new ArbError("VALIDATION_ERROR", "This verification link is invalid or expired.", 400);
    return user;
  }

  /** Always return normally so callers cannot discover whether an email exists. */
  async requestPasswordReset(email: string): Promise<void> {
    if (!this.sender) return;
    const user = await this.users.findByEmail(email);
    if (!user) return;

    const rawToken = actionToken();
    const now = this.clock();
    const actionId = await this.actions.issue(
      user.id,
      "reset_password",
      rawToken,
      now,
      now + this.resetTtlMs,
    );
    const link = `${this.appBaseUrl}/#/reset-password/${rawToken}`;
    await this.sender.send({
      to: user.email,
      subject: "Reset your Moonpaper password",
      text: `Reset your Moonpaper password: ${link}\n\nThis link expires in 60 minutes. If you did not request it, ignore this email.`,
      html: emailHtml(
        "Reset your password",
        "A password reset was requested for your Moonpaper account.",
        "Reset password",
        link,
        "This link expires in 60 minutes. If you did not request it, you can ignore this email.",
      ),
      idempotencyKey: `moonpaper-reset-${actionId}`,
    });
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<UserRecord> {
    // Hash before looking the token up. Invalid and valid requests therefore
    // have similar CPU cost, and no transaction is held during scrypt.
    const passwordHash = await hashPassword(newPassword);
    const user = await this.actions.resetPassword(rawToken, passwordHash, this.clock());
    if (!user) throw new ArbError("VALIDATION_ERROR", "This password-reset link is invalid or expired.", 400);
    return user;
  }
}

function emailHtml(title: string, intro: string, button: string, link: string, footer: string): string {
  const safeLink = escapeHtml(link);
  return `<!doctype html><html><body style="margin:0;background:#0b1020;color:#e8ecf5;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:40px 24px"><div style="font-size:13px;letter-spacing:2px;color:#9ba8c7">MOONPAPER · SIMULATED TRADING</div><h1 style="font-size:26px">${escapeHtml(title)}</h1><p style="line-height:1.6;color:#bdc7de">${intro}</p><p style="margin:28px 0"><a href="${safeLink}" style="display:inline-block;background:#9cf2c7;color:#07130e;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">${escapeHtml(button)}</a></p><p style="font-size:13px;line-height:1.5;color:#7f8ca8">${escapeHtml(footer)}</p></div></body></html>`;
}
