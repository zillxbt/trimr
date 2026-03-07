// Quick check: does Anthropic prompt caching actually fire for this model?
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
});

const system = 'You are a TypeScript expert. '.repeat(200); // ~1 400 real tokens

for (let i = 0; i < 3; i++) {
  const r = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 32,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] as never,
    messages: [{ role: 'user', content: `Say hi. Call ${i}` }],
  }, { headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' } });
  console.log(`call ${i}:`, JSON.stringify(r.usage));
}
