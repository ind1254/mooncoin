import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],

    /**
     * Vitest defaults to 5s per test and 10s per hook. That is too tight for
     * this suite: the database tests run against PGlite, which boots Postgres
     * compiled to WebAssembly and then applies every migration in
     * src/db/migrations for each file that needs a database. That work grows
     * with the migration count and is several times slower on a cold CI runner
     * than on a warm laptop, so the default produced failures that said
     * "timed out" when nothing was actually wrong.
     *
     * The limits are raised rather than removed. A test that genuinely hangs
     * should still fail rather than stall the run.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
