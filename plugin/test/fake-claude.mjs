#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests: echoes its arguments and environment
// through stream-json events the way `claude -p --output-format stream-json --verbose` does.
let task = '';
process.stdin.on('data', (d) => (task += d));
process.stdin.on('end', () => {
  const session = 'sess-123';
  const emit = (o) => process.stdout.write(JSON.stringify({ session_id: session, ...o }) + '\n');
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), model: process.env.ANTHROPIC_MODEL, tools: ['Read', 'Write'] });
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Writing.' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'out.txt', content: 'x' } }] },
  });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  if (task.includes('FAIL')) {
    process.stderr.write('boom\n');
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 2, duration_ms: 1500 });
    process.exit(1);
  }
  if (task.includes('HANG')) return setTimeout(() => {}, 1e9);
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    duration_ms: 65_000,
    result: JSON.stringify({
      task,
      args: process.argv.slice(2),
      base: process.env.ANTHROPIC_BASE_URL,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
      model: process.env.ANTHROPIC_MODEL,
      claudecode: process.env.CLAUDECODE ?? null,
      apiKey: process.env.ANTHROPIC_API_KEY ?? null,
      cwd: process.cwd(),
    }),
  });
});
