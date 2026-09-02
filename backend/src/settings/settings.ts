import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Single-user preferences with sensible defaults — the product must be usable
 * without configuring anything. Persisted as plain JSON (no secrets here).
 */

export type RiskPreference = "conservative" | "balanced" | "aggressive";

export const settingsSchema = z.object({
  defaultTradeSizeSol: z.number().positive().max(1_000).default(10),
  riskPreference: z.enum(["conservative", "balanced", "aggressive"]).default("balanced"),
  maxPriceImpactBps: z.number().int().min(1).max(5_000).default(100), // 1%
  maxSlippageBps: z.number().int().min(1).max(2_000).default(100), // 1%
  minLiquidityUsd: z.number().int().min(0).default(250_000),
  minTokenAgeDays: z.number().int().min(0).default(7),
  minOpportunityScore: z.number().int().min(0).max(100).default(55),
  watchlist: z.array(z.string().min(32).max(64)).default([]),
  positionAlertGainPct: z.number().min(1).max(1_000).default(20),
  positionAlertLossPct: z.number().min(1).max(100).default(10),
  notifications: z
    .object({
      opportunityMatch: z.boolean().default(true),
      scoreChange: z.boolean().default(true),
      liquidityDrop: z.boolean().default(true),
      riskIncrease: z.boolean().default(true),
      betterRoute: z.boolean().default(false),
      positionThreshold: z.boolean().default(true),
    })
    .default({}),
});

export type UserSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: UserSettings = settingsSchema.parse({});

/**
 * Account preferences exclude the legacy file-backed watchlist. Personal
 * watchlist membership has its own normalized table and must never be copied
 * into a settings blob where two writes could overwrite one another.
 */
export const accountSettingsSchema = settingsSchema.omit({ watchlist: true });
export type AccountSettings = z.infer<typeof accountSettingsSchema>;
export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = accountSettingsSchema.parse({});

/** Which token risk levels the user's preference accepts. */
export function allowedRiskLevels(pref: RiskPreference): Set<"low" | "medium" | "high"> {
  switch (pref) {
    case "conservative":
      return new Set(["low"]);
    case "balanced":
      return new Set(["low", "medium"]);
    case "aggressive":
      return new Set(["low", "medium", "high"]);
  }
}

export interface SettingsStore {
  get(): UserSettings;
  update(patch: unknown): UserSettings;
}

export class FileSettingsStore implements SettingsStore {
  private settings: UserSettings;

  constructor(private readonly filePath: string) {
    this.settings = this.loadOrDefault();
  }

  private loadOrDefault(): UserSettings {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      return settingsSchema.parse(raw);
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  get(): UserSettings {
    return this.settings;
  }

  update(patch: unknown): UserSettings {
    // Merge onto current, then re-validate the whole object
    const merged = { ...this.settings, ...(patch as Record<string, unknown>) };
    this.settings = settingsSchema.parse(merged);
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), "utf8");
    } catch (err) {
      console.error(JSON.stringify({ msg: "settings save failed", error: String(err) }));
    }
    return this.settings;
  }
}
