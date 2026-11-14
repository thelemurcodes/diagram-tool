/**
 * Post-generation cycle detection — pure logic for Mermaid flowcharts. Kept in
 * its own ESM module so the buildless frontend (docs/index.html) and the unit
 * tests (docs/test/) share one implementation.
 *
 * Why: the model sometimes loops a linear policy path back on itself (a
 * back-edge to an earlier step). The system prompt now asks for acyclic
 * output; this is the safety net. Warning only — the user decides whether the
 * loop is real. Nothing here logs or persists anything.
 */

/** Arrow and open-link operators that separate nodes on an edge line. */
const ARROW_RE = /-\.+->|-\.+|={2,}>|={3}|-{2,}>|-{3}/g;

/**
 * Extract directed edges from a Mermaid flowchart.
 *
 * Deliberately forgiving and best-effort: unparseable lines are skipped, not
 * thrown, because this runs on already-rendered diagrams. Only `flowchart`/
 * `graph` blocks are parsed — other diagram types have no node edges.
 *
 * @param {string} code Mermaid source.
 * @returns {Array<[string, string]>} [fromId, toId] pairs, in source order.
 */
export function parseFlowchartEdges(code) {
  const edges = [];
  let inFlowchart = false;
  for (const raw of String(code || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    if (/^(flowchart|graph)\b/i.test(line)) { inFlowchart = true; continue; }
    if (!inFlowchart) continue;
    if (/^(subgraph\b|end\b|classDef\b|class\s|style\s|click\s|direction\b)/i.test(line)) continue;

    // Strip what is not structure: pipe labels (A -->|text| B), quoted text,
    // and node shapes (A[Step], A(Step), A{Step}). What remains is node ids
    // separated by arrows; link text left over from `A -- text --> B` is
    // dropped by the id check below.
    const structural = line
      .replace(/\|"[^"]*"\|/g, " ")
      .replace(/\|[^|]*\|/g, " ")
      .replace(/"[^"]*"/g, "")
      .replace(/\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}/g, "")
      .replace(ARROW_RE, "\u2192");

    const ids = structural
      .split("\u2192")
      .map((tok) => {
        const m = tok.trim().match(/^[A-Za-z0-9_]+/);
        return m ? m[0] : null;
      })
      .filter(Boolean);

    for (let i = 0; i + 1 < ids.length; i++) edges.push([ids[i], ids[i + 1]]);
  }
  return edges;
}

/**
 * Detect cycles in a Mermaid flowchart via colored DFS.
 *
 * @param {string} code Mermaid source.
 * @returns {string[][]} One entry per cycle found: the node ids on the cycle,
 *   starting and ending at the node where the loop closes. Empty = acyclic.
 */
export function detectFlowchartCycles(code) {
  const adj = new Map();
  for (const [from, to] of parseFlowchartEdges(code)) {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const path = [];
  const cycles = [];

  function dfs(n) {
    color.set(n, GRAY);
    path.push(n);
    for (const m of adj.get(n) || []) {
      const c = color.has(m) ? color.get(m) : WHITE;
      if (c === GRAY) {
        const start = path.indexOf(m);
        cycles.push(path.slice(start).concat(m));
      } else if (c === WHITE) {
        dfs(m);
      }
    }
    path.pop();
    color.set(n, BLACK);
  }

  for (const n of adj.keys()) {
    if (!color.has(n) || color.get(n) === WHITE) dfs(n);
  }
  return cycles;
}
