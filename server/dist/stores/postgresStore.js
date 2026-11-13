"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostgresLeadStore = exports.PostgresLogStore = exports.SCHEMA_SQL = void 0;
const pg_1 = require("pg");
/**
 * Schema for the two Postgres tables (Neon in production). The Firestore
 * collections become these tables; the legacy GCP/Firestore instance is never
 * touched — new writes go here only.
 */
exports.SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS diagram_logs (
  id bigserial PRIMARY KEY,
  ts timestamptz DEFAULT now(),
  mode text,
  type text,
  prompt text,
  prompt_chars int,
  ip_hash text,
  referer text,
  template_id text,
  success bool,
  error text,
  mermaid_chars int,
  usage_in int,
  usage_out int
);
CREATE INDEX IF NOT EXISTS diagram_logs_ts_desc_idx ON diagram_logs (ts DESC);

CREATE TABLE IF NOT EXISTS leads (
  id bigserial PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  email text,
  interested_workflow text,
  source_page text,
  consent_terms_version text,
  ip_hash text,
  status text DEFAULT 'pending',
  confirm_token text
);
CREATE INDEX IF NOT EXISTS leads_confirm_token_idx ON leads (confirm_token);
`;
/** Postgres (Neon in production) LogStore. */
class PostgresLogStore {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    static async connect(connectionString) {
        const pool = new pg_1.Pool({ connectionString, max: 5 });
        const store = new PostgresLogStore(pool);
        await store.migrate();
        return store;
    }
    /** Create the tables if they don't exist (idempotent). */
    async migrate() {
        const client = await this.pool.connect();
        try {
            await client.query(exports.SCHEMA_SQL);
        }
        finally {
            client.release();
        }
    }
    async log(event) {
        await this.pool.query(`INSERT INTO diagram_logs
         (ts, mode, type, prompt, prompt_chars, ip_hash, referer, template_id,
          success, error, mermaid_chars, usage_in, usage_out)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [
            event.ts,
            event.mode,
            event.type,
            event.prompt,
            event.prompt_chars,
            event.ip_hash,
            event.referer,
            event.template_id,
            event.success,
            event.error ?? null,
            event.mermaid_chars ?? null,
            event.usage_in ?? null,
            event.usage_out ?? null,
        ]);
    }
    /**
     * Single SQL aggregation over the newest 500 records, returning the same
     * JSON shape the old Firestore-based handler returned.
     */
    async usageIntel() {
        const { rows } = await this.pool.query(`WITH recent AS (
         SELECT * FROM diagram_logs ORDER BY ts DESC LIMIT 500
       )
       SELECT
         count(*)::int AS total_fetched,
         count(*) FILTER (WHERE success)::float8 / NULLIF(count(*), 0)::float8 AS success_rate,
         (SELECT COALESCE(jsonb_object_agg(t, c), '{}'::jsonb)
            FROM (SELECT type AS t, count(*)::int AS c FROM recent WHERE type IS NOT NULL GROUP BY type) s
         ) AS by_type,
         (SELECT COALESCE(jsonb_object_agg(m, c), '{}'::jsonb)
            FROM (SELECT mode AS m, count(*)::int AS c FROM recent WHERE mode IS NOT NULL GROUP BY mode) s2
         ) AS by_mode,
         (SELECT COALESCE(jsonb_object_agg(t, c), '{}'::jsonb)
            FROM (SELECT template_id AS t, count(*)::int AS c FROM recent WHERE template_id IS NOT NULL GROUP BY template_id) s3
         ) AS by_template_id,
         (SELECT COALESCE(jsonb_object_agg(r, c), '{}'::jsonb)
            FROM (SELECT referer AS r, count(*)::int AS c FROM recent GROUP BY referer ORDER BY c DESC, r ASC LIMIT 10) s4
         ) AS by_referrer,
         (SELECT COALESCE(jsonb_object_agg(d, c), '{}'::jsonb)
            FROM (SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, count(*)::int AS c
                    FROM recent GROUP BY d ORDER BY d) s5
         ) AS daily_volume
       FROM recent`);
        const row = rows[0];
        return {
            totalFetched: row?.total_fetched ?? 0,
            successRate: row?.success_rate ?? 0,
            byType: row?.by_type ?? {},
            byMode: row?.by_mode ?? {},
            byTemplateId: row?.by_template_id ?? {},
            byReferrer: row?.by_referrer ?? {},
            dailyVolume: row?.daily_volume ?? {},
        };
    }
    async close() {
        await this.pool.end();
    }
}
exports.PostgresLogStore = PostgresLogStore;
/** Postgres (Neon in production) LeadStore. */
class PostgresLeadStore {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    static async connect(connectionString) {
        const pool = new pg_1.Pool({ connectionString, max: 5 });
        const store = new PostgresLeadStore(pool);
        await store.migrate();
        return store;
    }
    async migrate() {
        const client = await this.pool.connect();
        try {
            await client.query(exports.SCHEMA_SQL);
        }
        finally {
            client.release();
        }
    }
    async createLead(lead) {
        await this.pool.query(`INSERT INTO leads
         (email, interested_workflow, source_page, consent_terms_version,
          ip_hash, status, confirm_token)
       VALUES ($1,$2,$3,$4,$5,'pending',$6)`, [
            lead.email,
            lead.interestedWorkflow,
            lead.sourcePage,
            lead.consentTermsVersion,
            lead.ipHash,
            lead.confirmToken,
        ]);
    }
    async findByConfirmToken(token) {
        const { rows } = await this.pool.query(`SELECT id, email, interested_workflow, source_page, consent_terms_version,
              ip_hash, status, confirm_token, created_at
         FROM leads WHERE confirm_token = $1 LIMIT 1`, [token]);
        const r = rows[0];
        if (!r)
            return null;
        return {
            id: Number(r.id),
            email: r.email,
            interested_workflow: r.interested_workflow,
            source_page: r.source_page,
            consent_terms_version: r.consent_terms_version,
            ip_hash: r.ip_hash,
            status: r.status,
            confirm_token: r.confirm_token,
            created_at: new Date(r.created_at),
        };
    }
    async confirmLead(id) {
        // Status-only update; the token is kept so a replayed confirmation link
        // stays idempotent ("already confirmed"), matching MemoryLeadStore.
        await this.pool.query(`UPDATE leads SET status = 'confirmed' WHERE id = $1`, [id]);
    }
    async close() {
        await this.pool.end();
    }
}
exports.PostgresLeadStore = PostgresLeadStore;
//# sourceMappingURL=postgresStore.js.map