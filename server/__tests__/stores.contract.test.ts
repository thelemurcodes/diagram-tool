/**
 * New: store contract suite. The same assertions run against the in-memory
 * stores (unit tests, keyless CI) and the Postgres stores on a real embedded
 * Postgres server — so the two LogStore/LeadStore implementations cannot drift,
 * including the DIAG-ADR-001 confirmed-only lead rule.
 *
 * Skipped (not failed) when the embedded-postgres binaries are unavailable —
 * documented in AGENTS.md; CI installs the linux-x64 binaries explicitly.
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { LogStore, LeadStore, LogEvent } from '../src/stores/types';
import { MemoryLogStore, MemoryLeadStore } from '../src/stores/memoryStore';
import { PostgresLogStore, PostgresLeadStore } from '../src/stores/postgresStore';

jest.setTimeout(120_000);

function evt(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: new Date(),
    mode: 'describe',
    type: 'flowchart',
    prompt_chars: 1,
    ip_hash: 'aaa',
    referer: '',
    template_id: null,
    success: true,
    ...overrides,
  };
}

interface StoreFactory {
  name: string;
  makeStores: () => Promise<{ logStore: LogStore; leadStore: LeadStore; reset: () => Promise<void>; close: () => Promise<void> }>;
}

const factories: StoreFactory[] = [
  {
    name: 'in-memory',
    makeStores: async () => {
      const logStore = new MemoryLogStore();
      const leadStore = new MemoryLeadStore();
      return {
        logStore,
        leadStore,
        reset: async () => {
          (logStore as MemoryLogStore).rows.length = 0;
          (leadStore as MemoryLeadStore).rows.length = 0;
        },
        close: async () => {},
      };
    },
  },
];

// Embedded Postgres joins when its binaries are installed (linux-x64 in CI).
let embeddedAvailable = false;
try {
  require.resolve('embedded-postgres');
  require.resolve('@embedded-postgres/linux-x64/package.json');
  embeddedAvailable = true;
} catch {
  embeddedAvailable = false;
}

if (embeddedAvailable) {
  factories.push({
    name: 'postgres (embedded)',
    makeStores: async () => {
      const EmbeddedPostgres = require('embedded-postgres').default;
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-tool-pg-'));
      const pg = new EmbeddedPostgres({
        databaseDir: dataDir,
        user: 'postgres',
        password: 'password',
        port: 54329,
        persistent: false,
      });
      await pg.initialise();
      await pg.start();
      await pg.createDatabase('contract_test');
      const connectionString =
        'postgresql://postgres:password@localhost:54329/contract_test';
      const logStore = await PostgresLogStore.connect(connectionString);
      const leadStore = await PostgresLeadStore.connect(connectionString);
      return {
        logStore,
        leadStore,
        reset: async () => {
          const client = await (logStore as PostgresLogStore as any).pool.connect();
          try {
            await client.query('TRUNCATE diagram_logs; TRUNCATE leads;');
          } finally {
            client.release();
          }
        },
        close: async () => {
          await logStore.close!();
          await leadStore.close!();
          await pg.stop();
        },
      };
    },
  });
}

describe.each(factories)('LogStore contract — $name', ({ makeStores }) => {
  let ctx: Awaited<ReturnType<typeof makeStores>>;

  beforeAll(async () => {
    ctx = await makeStores();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('stores a logged event and reports it in usageIntel totals', async () => {
    await ctx.logStore.log(evt({ prompt_chars: 12 }));
    const intel = await ctx.logStore.usageIntel();
    expect(intel.totalFetched).toBe(1);
    expect(intel.successRate).toBeCloseTo(1);
  });

  it('breaks out byType, byMode, byTemplateId, byReferrer, dailyVolume', async () => {
    await ctx.logStore.log(
      evt({ type: 'flowchart', mode: 'describe', template_id: 'med-pass', referer: 'https://snf.org' })
    );
    await ctx.logStore.log(
      evt({ type: 'flowchart', mode: 'describe', template_id: 'med-pass', referer: 'https://snf.org' })
    );
    await ctx.logStore.log(
      evt({ type: 'sequence', mode: 'policy', template_id: null, referer: 'https://other.com', success: false, error: 'upstream_500' })
    );

    const intel = await ctx.logStore.usageIntel();
    expect(intel.totalFetched).toBe(3);
    expect(intel.successRate).toBeCloseTo(2 / 3);
    expect(intel.byType).toEqual({ flowchart: 2, sequence: 1 });
    expect(intel.byMode).toEqual({ describe: 2, policy: 1 });
    expect(intel.byTemplateId).toEqual({ 'med-pass': 2 });
    expect(intel.byReferrer['https://snf.org']).toBe(2);
    expect(intel.byReferrer['https://other.com']).toBe(1);
    expect(Object.values(intel.dailyVolume).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('aggregates only the newest 500 records', async () => {
    const now = Date.now();
    for (let i = 0; i < 505; i++) {
      await ctx.logStore.log(evt({ ts: new Date(now - i * 60_000) }));
    }
    const intel = await ctx.logStore.usageIntel();
    expect(intel.totalFetched).toBe(500);
  });

  it('returns zeroed aggregates for an empty store (no NaN)', async () => {
    const intel = await ctx.logStore.usageIntel();
    expect(intel.totalFetched).toBe(0);
    expect(intel.successRate).toBe(0);
    expect(intel.byType).toEqual({});
    expect(intel.byMode).toEqual({});
  });

  // DIAG-ADR-002 regression: raw prompt text must never reach either store.
  // A marker is smuggled in via a cast to simulate a caller still passing a
  // `prompt` field — if the Postgres INSERT ever persisted it again, the
  // SELECT check below fails. The memory store copies the event it is given
  // verbatim (it cannot sanitize), so for it the guarantee is that a normal
  // event persists with no `prompt` key — the app never constructs one.
  it('never persists raw prompt text (DIAG-ADR-002)', async () => {
    if (ctx.logStore instanceof MemoryLogStore) {
      await ctx.logStore.log(evt({}));
      const row = ctx.logStore.rows[0] as unknown as Record<string, unknown>;
      expect('prompt' in row).toBe(false);
      return;
    }

    const marker = 'POLICY-MARKER Resident Jane Doe (DOB 1931) requires insulin at 11:00';
    const event = evt({ prompt_chars: marker.length }) as unknown as Record<string, unknown>;
    event.prompt = marker;
    await ctx.logStore.log(event as unknown as LogEvent);

    const client = await (ctx.logStore as unknown as { pool: { connect(): Promise<any> } }).pool.connect();
    try {
      const { rows } = await client.query('SELECT * FROM diagram_logs');
      expect(rows).toHaveLength(1);
      const row: Record<string, unknown> = rows[0];
      expect('prompt' in row).toBe(false);
      for (const value of Object.values(row)) {
        expect(typeof value === 'string' ? value : JSON.stringify(value) ?? '').not.toContain(marker);
      }
    } finally {
      client.release();
    }
  });
});

describe.each(factories)('LeadStore contract — $name', ({ makeStores }) => {
  let ctx: Awaited<ReturnType<typeof makeStores>>;

  beforeAll(async () => {
    ctx = await makeStores();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates a pending lead and finds it by confirm token', async () => {
    await ctx.leadStore.createLead({
      email: 'admin@facility.com',
      interestedWorkflow: 'med-pass',
      sourcePage: '/templates/med-pass',
      consentTermsVersion: 'v1.0',
      ipHash: '0123456789abcdef',
      confirmToken: 'tok-123',
    });

    const lead = await ctx.leadStore.findByConfirmToken('tok-123');
    expect(lead).not.toBeNull();
    expect(lead!.email).toBe('admin@facility.com');
    expect(lead!.interested_workflow).toBe('med-pass');
    expect(lead!.source_page).toBe('/templates/med-pass');
    expect(lead!.consent_terms_version).toBe('v1.0');
    expect(lead!.ip_hash).toBe('0123456789abcdef');
    expect(lead!.status).toBe('pending');
    expect(lead!.confirm_token).toBe('tok-123');
    expect(lead!.created_at).toBeInstanceOf(Date);
  });

  it('returns null for an unknown token', async () => {
    expect(await ctx.leadStore.findByConfirmToken('nope')).toBeNull();
  });

  it('confirmLead flips status to confirmed; the link stays idempotent on replay', async () => {
    await ctx.leadStore.createLead({
      email: 'admin@facility.com',
      interestedWorkflow: null,
      sourcePage: null,
      consentTermsVersion: 'v1.0',
      ipHash: '0123456789abcdef',
      confirmToken: 'tok-confirm',
    });
    const lead = await ctx.leadStore.findByConfirmToken('tok-confirm');
    await ctx.leadStore.confirmLead(lead!.id);

    // DIAG-ADR-001 rule, as the app implements it: the confirmed lead is still
    // findable by token so a replayed link answers "already confirmed" (200,
    // no rewrite) instead of "invalid".
    const replayed = await ctx.leadStore.findByConfirmToken('tok-confirm');
    expect(replayed).not.toBeNull();
    expect(replayed!.status).toBe('confirmed');
  });

  it('confirming an already-confirmed lead is a no-op, not an error', async () => {
    await ctx.leadStore.createLead({
      email: 'admin@facility.com',
      interestedWorkflow: null,
      sourcePage: null,
      consentTermsVersion: 'v1.0',
      ipHash: '0123456789abcdef',
      confirmToken: 'tok-twice',
    });
    const lead = await ctx.leadStore.findByConfirmToken('tok-twice');
    await ctx.leadStore.confirmLead(lead!.id);
    await expect(ctx.leadStore.confirmLead(lead!.id)).resolves.toBeUndefined();
  });

  it('never exposes the raw IP — only the provided hash is stored', async () => {
    await ctx.leadStore.createLead({
      email: 'nurse@snf.org',
      interestedWorkflow: null,
      sourcePage: null,
      consentTermsVersion: 'v1.0',
      ipHash: 'aabbccddeeff0011',
      confirmToken: 'tok-hash',
    });
    const lead = await ctx.leadStore.findByConfirmToken('tok-hash');
    expect(lead!.ip_hash).toBe('aabbccddeeff0011');
    expect(JSON.stringify(lead)).not.toContain('192.168');
  });
});
