"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnthropicClient = exports.UpstreamError = void 0;
const config_1 = require("./config");
/** Thrown by AnthropicClient when the upstream call fails or errors. */
class UpstreamError extends Error {
    kind;
    status;
    detail;
    constructor(
    /** 'unreachable' = network failure; 'http' = non-2xx response. */
    kind, status, detail) {
        super(kind === 'http' ? `Upstream HTTP ${status}` : 'Upstream unreachable');
        this.kind = kind;
        this.status = status;
        this.detail = detail;
        this.name = 'UpstreamError';
    }
}
exports.UpstreamError = UpstreamError;
/**
 * Real client: fetch to api.anthropic.com. The key exists only inside this
 * file, read from ANTHROPIC_API_KEY — never the browser, never CI, never logs.
 */
class AnthropicClient {
    apiKey;
    model;
    fetchFn;
    constructor(apiKey, model = config_1.LIMITS.MODEL, fetchFn = fetch) {
        this.apiKey = apiKey;
        this.model = model;
        this.fetchFn = fetchFn;
    }
    async generate(req) {
        let res;
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
        }
        catch (e) {
            throw new UpstreamError('unreachable');
        }
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new UpstreamError('http', res.status, detail.slice(0, 300));
        }
        const data = (await res.json());
        const text = data && data.content && data.content[0] && data.content[0].text
            ? data.content[0].text
            : '';
        return {
            text,
            usageIn: data?.usage?.input_tokens ?? 0,
            usageOut: data?.usage?.output_tokens ?? 0,
        };
    }
}
exports.AnthropicClient = AnthropicClient;
//# sourceMappingURL=modelClient.js.map