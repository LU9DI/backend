import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listAiProviders, aiConfigured } from '../groqService.js';

describe('AI providers', () => {
  it('listAiProviders respeita chaves ausentes', () => {
    const prevG = process.env.GROQ_API_KEY;
    const prevM = process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    assert.deepEqual(listAiProviders(), []);
    assert.equal(aiConfigured(), false);

    if (prevG !== undefined) process.env.GROQ_API_KEY = prevG;
    if (prevM !== undefined) process.env.GEMINI_API_KEY = prevM;
  });

  it('detecta groq quando só GROQ_API_KEY existe', () => {
    const prevG = process.env.GROQ_API_KEY;
    const prevM = process.env.GEMINI_API_KEY;
    process.env.GROQ_API_KEY = 'gsk_test';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    assert.deepEqual(listAiProviders(), ['groq']);

    if (prevG !== undefined) process.env.GROQ_API_KEY = prevG;
    else delete process.env.GROQ_API_KEY;
    if (prevM !== undefined) process.env.GEMINI_API_KEY = prevM;
  });
});
