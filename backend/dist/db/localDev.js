/**
 * File-backed Postgres for local development only.
 *
 * PGlite persists to disk, so `npm run dev:local` gives a real Postgres —
 * same migrations, same constraints, same transactions as production — with
 * nothing to install and no cloud account.
 *
 * Imported dynamically because PGlite is a devDependency: production sets
 * DATABASE_URL and never reaches this path, so the module is never resolved
 * in a deployed bundle.
 */
export async function createLocalDevClient(dataDir) {
    try {
        const [{ PGlite }, { createPgliteBackedClient }] = await Promise.all([
            import("@electric-sql/pglite"),
            import("./pgliteClient.js"),
        ]);
        const db = new PGlite(dataDir, {
            // Same exactness guarantee as production: integers stay strings.
            parsers: { 20: (v) => v, 1700: (v) => v },
        });
        await db.waitReady;
        return createPgliteBackedClient(db);
    }
    catch (err) {
        console.warn(JSON.stringify({
            msg: "local dev database unavailable; accounts disabled",
            error: err.message,
        }));
        return undefined;
    }
}
