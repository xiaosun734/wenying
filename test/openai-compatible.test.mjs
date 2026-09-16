import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { OpenAICompatibleProvider } from '../server/providers/openai-compatible.mjs';

test('preserves structured JSON returned by an OpenAI-compatible provider', async () => {
  let requestBody;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ segments: [{ segmentId: 'segment-1', beats: [{ beatId: 'beat-1' }] }] }) } }],
        usage: { total_tokens: 42 },
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new OpenAICompatibleProvider({
      provider: 'test', baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: 'test-key', model: 'test-model', timeoutMs: 2000,
    });
    const result = await provider.requestStructured('system', 'user', 'director-test-v1');
    assert.equal(result.segments[0].segmentId, 'segment-1');
    assert.equal(result.segments[0].beats[0].beatId, 'beat-1');
    assert.equal(result.promptVersion, 'director-test-v1');
    assert.match(requestBody.messages[1].content, /json/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('retries transient structured provider failures', async () => {
  let attempts = 0;
  const server = http.createServer((req, res) => {
    attempts += 1;
    if (attempts < 3) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'temporary overload' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new OpenAICompatibleProvider({
      provider: 'test', baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: 'test-key', model: 'test-model', timeoutMs: 2000,
      structuredTimeoutMs: 2000, structuredRetries: 3, retryDelayMs: 0,
    });
    const result = await provider.requestStructured('system', 'user', 'retry-test-v1');
    assert.equal(result.ok, true);
    assert.equal(attempts, 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
