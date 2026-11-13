import {
  LogEvent,
  LogStore,
  LeadRow,
  LeadStore,
  NewLead,
  UsageIntel,
} from './types';

let nextId = 1;

/** In-memory LogStore — unit tests and keyless local dev. */
export class MemoryLogStore implements LogStore {
  rows: LogEvent[] = [];

  async log(event: LogEvent): Promise<void> {
    this.rows.push({ ...event });
  }

  async usageIntel(): Promise<UsageIntel> {
    // Newest 500 first — mirrors the Firestore orderBy(timestamp desc).limit(500).
    const docs = [...this.rows].sort((a, b) => b.ts.getTime() - a.ts.getTime()).slice(0, 500);

    const totalFetched = docs.length;
    let successCount = 0;
    const byType: Record<string, number> = {};
    const byMode: Record<string, number> = {};
    const byTemplateId: Record<string, number> = {};
    const byReferrerAll: Record<string, number> = {};
    const dailyVolume: Record<string, number> = {};

    for (const doc of docs) {
      if (doc.success === true) successCount++;
      if (doc.type) byType[doc.type] = (byType[doc.type] || 0) + 1;
      if (doc.mode) byMode[doc.mode] = (byMode[doc.mode] || 0) + 1;
      if (doc.template_id != null) {
        byTemplateId[doc.template_id] = (byTemplateId[doc.template_id] || 0) + 1;
      }
      const ref = doc.referer || '';
      byReferrerAll[ref] = (byReferrerAll[ref] || 0) + 1;
      if (doc.ts) {
        const day = doc.ts.toISOString().slice(0, 10);
        dailyVolume[day] = (dailyVolume[day] || 0) + 1;
      }
    }

    const successRate = totalFetched > 0 ? successCount / totalFetched : 0;

    const byReferrer = Object.entries(byReferrerAll)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reduce((acc, [k, v]) => {
        acc[k] = v;
        return acc;
      }, {} as Record<string, number>);

    return { totalFetched, successRate, byType, byMode, byTemplateId, byReferrer, dailyVolume };
  }

  async close(): Promise<void> {
    /* nothing to close */
  }
}

/** In-memory LeadStore — unit tests and keyless local dev. */
export class MemoryLeadStore implements LeadStore {
  rows: LeadRow[] = [];

  async createLead(lead: NewLead): Promise<void> {
    this.rows.push({
      id: nextId++,
      email: lead.email,
      interested_workflow: lead.interestedWorkflow,
      source_page: lead.sourcePage,
      consent_terms_version: lead.consentTermsVersion,
      ip_hash: lead.ipHash,
      // DIAG-ADR-001 rule: rows start 'pending'; only 'confirmed' rows may
      // ever be contacted or exported.
      status: 'pending',
      confirm_token: lead.confirmToken,
      created_at: new Date(),
    });
  }

  async findByConfirmToken(token: string): Promise<LeadRow | null> {
    return this.rows.find((r) => r.confirm_token === token) || null;
  }

  async confirmLead(id: number): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row && row.status !== 'confirmed') {
      row.status = 'confirmed';
      // The token is kept, not cleared: re-clicking the confirmation link must
      // stay idempotent (the app answers "already confirmed", never "invalid").
    }
  }

  async close(): Promise<void> {
    /* nothing to close */
  }
}
