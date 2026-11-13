import { LIMITS } from './config';

/**
 * The one seam the whole port exists to create: nothing outside ModelClient
 * implementations talks to the model. The handler, the tests, and CI all
 * depend only on this interface.
 */
export interface GenerateRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  /** Hint fields for fixture-keyed fakes; ignored by the real client. */
  mode?: string;
  type?: string;
}

export interface GenerateResult {
  /** Raw model text (may still carry code fences — the caller cleans it). */
  text: string;
  usageIn: number;
  usageOut: number;
}

export interface ModelClient {
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** Thrown by AnthropicClient when the upstream call fails or errors. */
export class UpstreamError extends Error {
  constructor(
    /** 'unreachable' = network failure; 'http' = non-2xx response. */
    public readonly kind: 'unreachable' | 'http',
    public readonly status?: number,
    public readonly detail?: string
  ) {
    super(kind === 'http' ? `Upstream HTTP ${status}` : 'Upstream unreachable');
    this.name = 'UpstreamError';
  }
}

/**
 * Real client: fetch to api.anthropic.com. The key exists only inside this
 * file, read from ANTHROPIC_API_KEY — never the browser, never CI, never logs.
 */
export class AnthropicClient implements ModelClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = LIMITS.MODEL,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    let res: Response;
    try {
      res = await this.fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.prompt }],
        }),
      });
    } catch (e) {
      throw new UpstreamError('unreachable');
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new UpstreamError('http', res.status, detail.slice(0, 300));
    }

    const data = (await res.json()) as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text =
      data && data.content && data.content[0] && data.content[0].text
        ? data.content[0].text
        : '';
    return {
      text,
      usageIn: data?.usage?.input_tokens ?? 0,
      usageOut: data?.usage?.output_tokens ?? 0,
    };
  }
}
