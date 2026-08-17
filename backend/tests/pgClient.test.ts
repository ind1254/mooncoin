import { describe, expect, it } from "vitest";
import { normalizePgConnectionString } from "../src/db/pgClient.js";

describe("Postgres connection security", () => {
  it("normalizes legacy hosted TLS modes without weakening explicit settings", () => {
    const hosted = new URL(
      normalizePgConnectionString("postgres://user:secret@db.example.com/app?sslmode=require", true),
    );
    expect(hosted.searchParams.get("sslmode")).toBe("verify-full");

    const explicit = new URL(
      normalizePgConnectionString("postgres://user:secret@db.example.com/app?sslmode=no-verify", true),
    );
    expect(explicit.searchParams.get("sslmode")).toBe("no-verify");

    const local = new URL(
      normalizePgConnectionString(
        "postgres://local:local@127.0.0.1/app?sslmode=require&sslcert=client.pem",
        false,
      ),
    );
    expect(local.searchParams.has("sslmode")).toBe(false);
    expect(local.searchParams.has("sslcert")).toBe(false);
  });
});
