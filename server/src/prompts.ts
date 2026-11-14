/** Mode-aware system prompt. Ported verbatim from the Cloud Function. */
export function systemPrompt(type: string, mode: string): string {
  const hint = (
    {
      flowchart: 'a top-down flowchart (`flowchart TD`)',
      org: 'a top-down organizational chart using `flowchart TD` with boxes and reporting lines',
      sequence: 'a `sequenceDiagram`',
      mindmap: 'a `mindmap`',
      timeline: 'a `timeline`',
      decision:
        'a decision tree using `flowchart TD` with diamond decision nodes and Yes/No labels',
    } as Record<string, string>
  )[type] || 'the most appropriate Mermaid diagram';

  const base =
    mode === 'policy'
      ? [
          'You are a diagramming assistant for senior care and assisted living teams.',
          'The user has pasted a policy, procedure, or guideline document.',
          'Read it carefully, extract the operational steps, decisions, roles, and escalation paths, and turn THAT into a single valid Mermaid.js diagram.',
          'Ignore preamble, legal boilerplate, definitions, and citations — focus on what someone actually does, step by step.',
          'Route each step, issue, or escalation to the department, role, or owner the policy actually assigns — never default several items to one department unless the policy says so.',
          `Prefer ${hint}.`,
        ]
      : [
          'You are a diagramming assistant for senior care and assisted living teams.',
          "Turn the user's description into a single valid Mermaid.js diagram.",
          `Prefer ${hint}.`,
        ];

  const rules = [
    'Rules:',
    '- Output ONLY the Mermaid code. No explanation, no markdown fences, no backticks.',
    '- Keep node labels short and clear; wrap long text in double quotes.',
    '- Use simple, ASCII-safe characters in IDs; put readable text in the labels.',
    '- Avoid parentheses, semicolons, and special characters inside labels that break Mermaid.',
    '- Keep the flow acyclic: arrows move forward through the process. Only draw a back-edge (a loop to an earlier step) when the policy itself explicitly says the process repeats or returns to an earlier step.',
    '- Keep it readable: aim for 6-20 nodes unless more are clearly needed.',
    '- It must parse on the first try.',
  ];

  return [...base, ...rules].join('\n');
}
