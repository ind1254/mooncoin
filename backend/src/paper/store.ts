import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PaperPosition } from "./types.js";

/**
 * Local JSON persistence for paper-trading state.
 * bigint fields travel as strings tagged "n:<digits>" so round-trips are exact.
 * The data directory is gitignored — simulated state never enters version control.
 */

export interface PaperState {
  startingBalanceLamports: bigint;
  cashLamports: bigint;
  positions: PaperPosition[];
}

const TAG = "n:";

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${TAG}${value.toString()}` : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.startsWith(TAG) && /^n:-?\d+$/.test(value)) {
    return BigInt(value.slice(TAG.length));
  }
  return value;
}

export interface PaperStateStore {
  load(): PaperState | null;
  save(state: PaperState): void;
}

export class FilePaperStateStore implements PaperStateStore {
  constructor(private readonly filePath: string) {}

  load(): PaperState | null {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      return JSON.parse(raw, reviver) as PaperState;
    } catch {
      return null; // first run or unreadable file → start fresh
    }
  }

  save(state: PaperState): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(state, replacer, 2), "utf8");
    } catch (err) {
      // Persistence is best-effort; losing paper state must never crash the app
      console.error(JSON.stringify({ msg: "paper-state save failed", error: String(err) }));
    }
  }
}

export class InMemoryPaperStateStore implements PaperStateStore {
  private state: PaperState | null = null;
  load(): PaperState | null {
    return this.state;
  }
  save(state: PaperState): void {
    this.state = state;
  }
}
