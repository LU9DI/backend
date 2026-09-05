import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSentimentHeuristic,
  sentimentFromRating,
  parseSentimentFromAiJson,
} from '../lib/sentiment.js';

describe('sentiment', () => {
  it('nota alta → positivo', () => {
    const s = sentimentFromRating(5);
    assert.equal(s.label, 'positivo');
    assert.ok(s.score > 0);
  });

  it('nota baixa → negativo', () => {
    const s = sentimentFromRating(1);
    assert.equal(s.label, 'negativo');
    assert.ok(s.score < 0);
  });

  it('heurística detecta palavras negativas', () => {
    const s = analyzeSentimentHeuristic(3, 'Atendimento péssimo e demora absurda');
    assert.equal(s.label, 'negativo');
    assert.ok((s.keywords?.length || 0) > 0);
  });

  it('heurística detecta palavras positivas', () => {
    const s = analyzeSentimentHeuristic(4, 'Comida excelente, adorei o ambiente');
    assert.equal(s.label, 'positivo');
  });

  it('parse JSON da IA', () => {
    const s = parseSentimentFromAiJson(
      '{"sentimento":"negativo","score":-0.8,"keywords":["demora"]}'
    );
    assert.ok(s);
    assert.equal(s!.label, 'negativo');
    assert.equal(s!.source, 'ia');
  });
});
