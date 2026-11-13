/**
 * Persistence interfaces — the port of the two Firestore collections.
 * Every store has two implementations: in-memory (unit tests, local dev) and
 * Postgres on Neon (production). One contract suite runs against both.
 */

/** One row of `diagram_logs`. Field names match the Firestore doc fields. */
export interface LogEvent {
  ts: Date;
  mode: string;
  type: string;
  prompt: string;
  prompt_chars: number;
  ip_hash: string;
  referer: string;
  template_id: string | null;
  success: boolean;
  error?: string | null;
  mermaid_chars?: number | null;
  usage_in?: number | null;
  usage_out?: number | null;
}

/** Shape returned by the usage_intel endpoint (contract carried over verbatim). */
export interface UsageIntel {
  totalFetched: number;
  successRate: number;
  byType: Record<string, number>;
  byMode: Record<string, number>;
  byTemplateId: Record<string, number>;
  byReferrer: Record<string, number>;
  dailyVolume: Record<string, number>;
}

export interface LogStore {
  log(event: LogEvent): Promise<void>;
  /** Aggregate over the newest 500 records, same JSON shape as the old handler. */
  usageIntel(): Promise<UsageIntel>;
  close?(): Promise<void>;
}

/** One row of `leads`. */
export interface LeadRow {
  id: number;
  email: string;
  interested_workflow: string | null;
  source_page: string | null;
  consent_terms_version: string;
  ip_hash: string;
  status: 'pending' | 'confirmed';
  confirm_token: string | null;
  created_at: Date;
}

export interface NewLead {
  email: string;
  interestedWorkflow: string | null;
  sourcePage: string | null;
  consentTermsVersion: string;
  ipHash: string;
  confirmToken: string;
}

export interface LeadStore {
  createLead(lead: NewLead): Promise<void>;
  findByConfirmToken(token: string): Promise<LeadRow | null>;
  /** Confirm the lead and clear its token (one-click links become invalid). */
  confirmLead(id: number): Promise<void>;
  close?(): Promise<void>;
}
