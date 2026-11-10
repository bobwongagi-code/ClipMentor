import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateText } from 'ai';
import { createServerLanguageModel, serverProviderOptions } from './model';

let originHeader: string | undefined;
let fetchSiteHeader: string | undefined;
const received: Array<{ url: string; provider: string | string[] | undefined; body: any }> = [];
const server = createServer(async (req, res) => {
  originHeader = req.headers.origin;
  fetchSiteHeader = req.headers['sec-fetch-site'];
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  received.push({ url: req.url!, provider: req.headers['x-openchatcut-provider'], body: JSON.parse(Buffer.concat(chunks).toString()) });
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end('{"error":{"message":"captured"}}');
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  await assert.rejects(generateText({
    model: createServerLanguageModel('deepseek', 'test-model', 'chat', origin),
    prompt: 'test',
    maxRetries: 0,
  }));
  assert.equal(originHeader, origin);
  assert.equal(fetchSiteHeader, 'same-origin');
  for (const apiMode of ['chat', 'responses'] as const) {
    const before = received.length;
    await assert.rejects(generateText({
      model: createServerLanguageModel('openai', 'frozen-gateway-model', apiMode, origin),
      prompt: 'Frozen instruction.', maxOutputTokens: 1234, temperature: 0.2, topP: 0.7,
      providerOptions: serverProviderOptions('openai', apiMode, 'short'), maxRetries: 0,
    }));
    assert.equal(received.length, before + 1, 'Local protocol refusal must not cause automatic resubmission');
    const wire = received.at(-1)!;
    assert.equal(wire.provider, 'openai');
    assert.equal(wire.body.model, 'frozen-gateway-model');
    assert.equal(wire.body.temperature, 0.2); assert.equal(wire.body.top_p, 0.7);
    if (apiMode === 'chat') {
      assert.equal(wire.url, '/llm/chat/completions');
      assert.equal(wire.body.max_tokens, 1234);
      assert.deepEqual(wire.body.messages, [{ role: 'user', content: 'Frozen instruction.' }]);
    } else {
      assert.equal(wire.url, '/llm/responses');
      assert.equal(wire.body.max_output_tokens, 1234);
      assert.equal(wire.body.store, false);
      assert.deepEqual(wire.body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'Frozen instruction.' }] }]);
    }
  }
  const before = received.length;
  await assert.rejects(generateText({
    model: createServerLanguageModel('gemini', 'frozen-gateway-gemini', 'chat', origin),
    prompt: 'Frozen instruction.', maxOutputTokens: 1234, temperature: 0.2, topP: 0.7, maxRetries: 0,
  }));
  assert.equal(received.length, before + 1);
  const google = received.at(-1)!;
  assert.equal(google.provider, 'gemini');
  assert.equal(google.url, '/llm/models/frozen-gateway-gemini:generateContent');
  assert.deepEqual(google.body.generationConfig, { maxOutputTokens: 1234, temperature: 0.2, topP: 0.7 });
  assert.deepEqual(google.body.contents, [{ role: 'user', parts: [{ text: 'Frozen instruction.' }] }]);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('agent-runs/model.verify: internal origin gate and frozen Gemini/chat/responses wire parameters retained, one submission per refusal');
