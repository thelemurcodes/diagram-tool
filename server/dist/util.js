"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = void 0;
exports.cleanMermaid = cleanMermaid;
exports.hashIp = hashIp;
exports.clientIp = clientIp;
const crypto_1 = __importDefault(require("crypto"));
/** In-memory soft rate limiter (per warm instance). Ported verbatim. */
class RateLimiter {
    hits = new Map();
    allow(key, limit, windowMs) {
        const now = Date.now();
        const e = this.hits.get(key);
        if (!e || now > e.resetAt) {
            this.hits.set(key, { count: 1, resetAt: now + windowMs });
            return true;
        }
        if (e.count >= limit)
            return false;
        e.count++;
        return true;
    }
    /** Occasionally drop expired windows so the map doesn't grow unbounded. */
    sweep() {
        const now = Date.now();
        for (const [k, v] of this.hits)
            if (now > v.resetAt)
                this.hits.delete(k);
    }
}
exports.RateLimiter = RateLimiter;
/** Strip code fences / stray backticks. Ported verbatim. */
function cleanMermaid(raw) {
    let s = (raw || '').trim();
    const fence = s.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
    if (fence)
        s = fence[1].trim();
    return s.replace(/^`+|`+$/g, '').trim();
}
/** One-way IP hash (so we never store raw IPs). Ported verbatim. */
function hashIp(ip) {
    return crypto_1.default
        .createHash('sha256')
        .update(String(ip || 'unknown'))
        .digest('hex')
        .slice(0, 16);
}
/** Extract the client IP the way the Cloud Function did (x-forwarded-for). */
function clientIp(headers) {
    return (String(headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim() || 'unknown');
}
//# sourceMappingURL=util.js.map