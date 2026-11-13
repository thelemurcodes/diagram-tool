"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecordedResponseClient = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
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
class RecordedResponseClient {
    fixturesDir;
    constructor(fixturesDir) {
        this.fixturesDir = fixturesDir;
    }
    fixturePath(mode, type) {
        const candidates = [
            path_1.default.join(this.fixturesDir, `${mode}-${type}.json`),
            path_1.default.join(this.fixturesDir, `${mode}-flowchart.json`),
            path_1.default.join(this.fixturesDir, 'describe-flowchart.json'),
        ];
        for (const p of candidates) {
            if (fs_1.default.existsSync(p))
                return p;
        }
        return null;
    }
    async generate(req) {
        const mode = req.mode === 'policy' ? 'policy' : 'describe';
        const type = req.type || 'flowchart';
        const file = this.fixturePath(mode, type);
        if (!file) {
            throw new Error(`No recorded fixture for mode=${mode} type=${type}`);
        }
        const fixture = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        return {
            text: fixture.text,
            usageIn: fixture.usageIn,
            usageOut: fixture.usageOut,
        };
    }
}
exports.RecordedResponseClient = RecordedResponseClient;
//# sourceMappingURL=recordedClient.js.map