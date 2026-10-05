import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnderratedPlace } from '../lib/acquisitionPlaceFilter.js';

test('aceita empresas mal avaliadas com avaliações suficientes', () => {
  delete process.env.ACQUISITION_MAX_RATING;
  delete process.env.ACQUISITION_MIN_REVIEWS;
  assert.equal(isUnderratedPlace({ rating: 3.8, userRatingCount: 60 }), true);
  assert.equal(isUnderratedPlace({ rating: 4.2, userRatingCount: 20 }), true);
});

test('rejeita empresas bem avaliadas, sem nota ou com poucas avaliações', () => {
  assert.equal(isUnderratedPlace({ rating: 4.7, userRatingCount: 300 }), false);
  assert.equal(isUnderratedPlace({ rating: 4.3, userRatingCount: 50 }), false);
  assert.equal(isUnderratedPlace({ rating: 3.5, userRatingCount: 5 }), false);
  assert.equal(isUnderratedPlace({ userRatingCount: 50 }), false);
  assert.equal(isUnderratedPlace(null), false);
});

test('limites configuráveis por env', () => {
  process.env.ACQUISITION_MAX_RATING = '4.5';
  process.env.ACQUISITION_MIN_REVIEWS = '5';
  assert.equal(isUnderratedPlace({ rating: 4.4, userRatingCount: 6 }), true);
  delete process.env.ACQUISITION_MAX_RATING;
  delete process.env.ACQUISITION_MIN_REVIEWS;
});
