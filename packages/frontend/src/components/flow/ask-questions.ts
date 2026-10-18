// Placeholder questions of the Ask bar, built from the current graph: real node
// names where there are some, the selected node first. Pure.
import type { FlowGraph, FlowNode, FlowWindow } from './types';

const WINDOW_WORDS: Record<FlowWindow, string> = { '1h': 'the last hour', '24h': 'the last 24 hours', '7d': 'the last 7 days' };

function about(node: FlowNode): string {
  switch (node.kind) {
    case 'tool':
      return (node.stats?.errors ?? 0) > 0 ? `Why did ${node.label} fail?` : `Who calls ${node.label}?`;
    case 'script':
      return `Which tools does ${node.label} call?`;
    case 'connector':
      return `Which tools use ${node.label}?`;
    case 'processing':
      return `What does the processing on ${node.label.replace(/ processing$/, '')} do?`;
    case 'mapping':
      return `What does the mapping on ${node.label.replace(/ mapping$/, '')} keep?`;
    case 'server':
      return `Which tools on ${node.label} fail most?`;
    default:
      return `What changed in ${WINDOW_WORDS['1h']}?`;
  }
}

const byErrors = (a: FlowNode, b: FlowNode) =>
  (b.stats?.errors ?? 0) - (a.stats?.errors ?? 0) || (b.stats?.calls ?? 0) - (a.stats?.calls ?? 0);

/** Five questions; the first is about the selected node when there is one. */
export function askQuestions(graph: FlowGraph | null, selected: FlowNode | null, window: FlowWindow): string[] {
  const nodes = graph?.nodes ?? [];
  const tools = nodes.filter((n) => n.kind === 'tool').sort(byErrors);
  const failing = tools.find((n) => (n.stats?.errors ?? 0) > 0) ?? tools[0];
  const script = nodes.filter((n) => n.kind === 'script').sort(byErrors)[0];
  const processed = nodes.find((n) => n.kind === 'processing');

  const out = [
    failing ? `Why did ${failing.label} fail?` : 'Which tool fails most?',
    script ? `Which tools does ${script.label} call?` : 'Which tools does a script call?',
    `What changed in ${WINDOW_WORDS[window]}?`,
    'Which connector has the most errors?',
    processed
      ? `What does the processing on ${processed.label.replace(/ processing$/, '')} do?`
      : 'What does the processing on this tool do?',
  ];
  if (selected && selected.kind !== 'agent') {
    const first = about(selected);
    return [first, ...out.filter((q) => q !== first)].slice(0, 5);
  }
  return out;
}
