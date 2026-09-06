  /** Stand-in for a real agent until the reference workload exists (M0). */
import { recorderFromEnv } from '@rewind/sdk-js/env';

const recorder = await recorderFromEnv({ thread_id: 'th_fixture' });
console.log('agent: working'); // proves stdio passes through

// `?.` is the whole fail-open contract: un-wrapped runs skip recording.
recorder?.record({
  node: 'plan',
  kind: 'model',
  request: { kind: 'model', provider: 'anthropic', model_id: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'ping ada@example.com' }] },
  response: { content: 'pong' },
  latency_ms: 12,
  tokens: 7,
});
recorder?.record({
  node: 'search',
  kind: 'tool',
  request: { kind: 'tool', tool_name: 'web_search', args: { q: 'rewind' } },
  response: { hits: 1 },
  latency_ms: 30,
});
recorder?.finish({ final_state_hash: 'sha256:fixture' });

// Exit code is configurable so a test can prove it propagates.
process.exitCode = Number(process.env['FIXTURE_EXIT'] ?? 0);
