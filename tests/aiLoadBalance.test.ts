import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAiLoadStats, listAiProviders, aiConfigured } from '../groqService.js';

describe('AI load balance stats', () => {
  it('getAiLoadStats expõe mode e contadores', () => {
    const s = getAiLoadStats();
    assert.ok(['round_robin', 'weighted', 'failover'].includes(s.mode));
    assert.ok(s.stats.groq);
    assert.ok(s.stats.gemini);
    assert.equal(typeof s.stats.groq.success, 'number');
  });

  it('listAiProviders sem chaves fica vazio', () => {
    const g = process.env.GROQ_API_KEY;
    const m = process.env.GEMINI_API_KEY;
    const o = process.env.GOOGLE_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    assert.deepEqual(listAiProviders(), []);
    assert.equal(aiConfigured(), false);

    if (g !== undefined) process.env.GROQ_API_KEY = g;
    if (m !== undefined) process.env.GEMINI_API_KEY = m;
    if (o !== undefined) process.env.GOOGLE_API_KEY = o;
  });
});
