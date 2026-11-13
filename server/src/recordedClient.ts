import fs from 'fs';
import path from 'path';
import { ModelClient, GenerateRequest, GenerateResult } from './modelClient';

/**
 * Deterministic fake for tests and CI: serves recorded responses from JSON
 * fixtures keyed by mode + diagram type. Chosen so the full stack runs with
 * no Anthropic key anywhere (program rule: CI is green without the key).
 *
 * Fixture lookup order:
 *   1. server/fixtures/<mode>-<type>.json
 *   2. server/fixtures/<mode>-flowchart.json
 *   3. server/fixtures/describe-flowchart.json
 *
 * Once an ANTHROPIC_API_KEY exists, real Haiku responses can be recorded over
 * these fixtures (see README — one-command re-record).
 */
export class RecordedResponseClient implements ModelClient {
  constructor(private readonly fixturesDir: string) {}

  private fixturePath(mode: string, type: string): string | null {
    const candidates = [
      path.join(this.fixturesDir, `${mode}-${type}.json`),
      path.join(this.fixturesDir, `${mode}-flowchart.json`),
      path.join(this.fixturesDir, 'describe-flowchart.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const mode = req.mode === 'policy' ? 'policy' : 'describe';
    const type = req.type || 'flowchart';

    const file = this.fixturePath(mode, type);
    if (!file) {
      throw new Error(`No recorded fixture for mode=${mode} type=${type}`);
    }
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      text: string;
      usageIn: number;
      usageOut: number;
    };
    return {
      text: fixture.text,
      usageIn: fixture.usageIn,
      usageOut: fixture.usageOut,
    };
  }
}
