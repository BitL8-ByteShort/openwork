import { test, expect } from 'vitest';
import { artifactCandidates } from '../src/artifacts/candidates.js';

const file = (path: string) => ({ path, mime: 'application/pdf', bytes: 42, sha256: '1'.repeat(64) });
const tool = (files: unknown[], status = 'completed', name = 'execute') => ({ type: 'assistant', content: [{
  type: 'tool', name, executed: false, state: { status, content: [{ type: 'text', text: JSON.stringify({ files }) }], metadata: {} },
}] });

test('completed native tool manifests retain literal paths, even when native executed is false', () => {
  expect(artifactCandidates([tool([file('Results/Report.pdf')])])).toEqual({ items: [{ path: 'Results/Report.pdf', source: 'completed_tool_manifest' }], moreOnComputer: false });
});

test('only explicit assistant links inside the outbox become transcript candidates', () => {
  const path = '.opencode/openwork/outbox/results/report.pdf';
  expect(artifactCandidates([
    { type: 'user', text: `[private](.opencode/openwork/outbox/private.txt)` },
    { type: 'assistant', text: `Created [report](${path}). Also [secret](private.txt), [web](https://example.test/a.pdf) and prose other.pdf.` },
  ])).toEqual({ items: [{ path, source: 'assistant_outbox_link' }], moreOnComputer: false });
});

test('running, failed and nonzero-exit tools do not authorize result candidates', () => {
  const nonzero = tool([file('report.pdf')]); nonzero.content[0]!.state.metadata = { exit: 1 };
  expect(artifactCandidates([tool([file('running.pdf')], 'running'), tool([file('failed.pdf')], 'error'), nonzero])).toEqual({ items: [], moreOnComputer: false });
});

test('unrelated tool JSON and malformed file declarations are ignored', () => {
  expect(artifactCandidates([tool([file('read.pdf')], 'completed', 'read_file'), tool([
    file('https://example.test/a.pdf'), file('../../outside.pdf'), file('result\u0000.pdf'), { path: 'unmeasured.pdf' },
    { ...file('bad.pdf'), bytes: -1 }, { ...file('bad-hash.pdf'), sha256: 'bad' },
  ])])).toEqual({ items: [], moreOnComputer: false });
});

test('completed write metadata is associated with its chat without scanning shell commands', () => {
  expect(artifactCandidates([{ type: 'assistant', content: [
    { type: 'tool', name: 'write_file', state: { status: 'completed', input: { path: 'report.txt' } } },
    { type: 'tool', name: 'shell', state: { status: 'completed', input: { command: 'echo made-secret.txt' }, content: [{ type: 'text', text: 'made-secret.txt' }] } },
  ] }])).toEqual({ items: [{ path: 'report.txt', source: 'completed_write_metadata' }], moreOnComputer: false });
});

test('paths are case sensitive, deduplicated literally and output is bounded with an explicit notice', () => {
  const files = Array.from({ length: 101 }, (_, n) => file(`results/${n}.pdf`));
  const result = artifactCandidates([tool([file('Report.pdf'), file('report.pdf'), file('Report.pdf')]), tool(files)]);
  expect(result.items.slice(0, 2).map(x => x.path)).toEqual(['Report.pdf', 'report.pdf']);
  expect(result.items).toHaveLength(100); expect(result.moreOnComputer).toBe(true);
});

test('oversized tool text never enters JSON parsing or becomes a path candidate', () => {
  expect(artifactCandidates([{ type: 'assistant', content: [{ type: 'tool', name: 'execute', state: { status: 'completed', content: [{ type: 'text', text: 'x'.repeat(1_048_577) }] } }] }])).toEqual({ items: [], moreOnComputer: true });
});
