import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const TAG = "n:";
function replacer(_key, value) {
    return typeof value === "bigint" ? `${TAG}${value.toString()}` : value;
}
function reviver(_key, value) {
    if (typeof value === "string" && value.startsWith(TAG) && /^n:-?\d+$/.test(value)) {
        return BigInt(value.slice(TAG.length));
    }
    return value;
}
export class FilePaperStateStore {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
    }
    load() {
        try {
            const raw = readFileSync(this.filePath, "utf8");
            return JSON.parse(raw, reviver);
        }
        catch {
            return null; // first run or unreadable file → start fresh
        }
    }
    save(state) {
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            writeFileSync(this.filePath, JSON.stringify(state, replacer, 2), "utf8");
        }
        catch (err) {
            // Persistence is best-effort; losing paper state must never crash the app
            console.error(JSON.stringify({ msg: "paper-state save failed", error: String(err) }));
        }
    }
}
export class InMemoryPaperStateStore {
    state = null;
    load() {
        return this.state;
    }
    save(state) {
        this.state = state;
    }
}
