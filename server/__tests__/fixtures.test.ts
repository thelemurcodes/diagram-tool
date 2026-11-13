/**
 * New: fixture validation. The recorded-response fake is what CI runs on, so a
 * broken fixture must fail loudly: valid JSON, no fences, and a mermaid
 * keyword that matches the diagram type it is keyed for.
 */
import fs from 'fs';
import path from 'path';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

interface Fixture {
  text: string;
  usageIn: number;
  usageOut: number;
}

const KEYWORD_BY_TYPE: Record<string, string[]> = {
  flowchart: ['flowchart'],
  decision: ['flowchart'],
  sequence: ['sequenceDiagram'],
  mindmap: ['mindmap'],
  timeline: ['timeline'],
};

function fixtureFiles(): string[] {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

describe('recorded fixtures', () => {
  it('there are fixtures for every expected mode+type key', () => {
    const files = fixtureFiles();
    for (const expected of [
      'describe-flowchart.json',
      'describe-decision.json',
      'describe-sequence.json',
      'describe-mindmap.json',
      'describe-timeline.json',
      'policy-flowchart.json',
    ]) {
      expect(files).toContain(expected);
    }
  });

  it.each(fixtureFiles())('%s parses with the recorded-response shape', (file) => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
    const fixture = JSON.parse(raw) as Fixture;
    expect(typeof fixture.text).toBe('string');
    expect(fixture.text.length).toBeGreaterThan(0);
    expect(typeof fixture.usageIn).toBe('number');
    expect(fixture.usageIn).toBeGreaterThan(0);
    expect(typeof fixture.usageOut).toBe('number');
    expect(fixture.usageOut).toBeGreaterThan(0);
  });

  it.each(fixtureFiles())('%s contains no markdown fences or backticks', (file) => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8')
    ) as Fixture;
    expect(fixture.text).not.toContain('```');
    expect(fixture.text).not.toContain('`');
  });

  it.each(fixtureFiles())('%s starts with the mermaid keyword its type implies', (file) => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8')
    ) as Fixture;
    // filename: <mode>-<type>.json
    const type = file.replace(/\.json$/, '').split('-')[1];
    const keywords = KEYWORD_BY_TYPE[type];
    expect(keywords).toBeDefined();
    const firstLine = fixture.text.trim().split('\n')[0];
    expect(keywords.some((k) => firstLine.startsWith(k))).toBe(true);
  });
});
