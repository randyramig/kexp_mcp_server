import assert from 'node:assert/strict';
import test from 'node:test';
import { buildKexpItemUrl, buildKexpListUrl } from './kexpClient.js';

test('buildKexpListUrl adds pagination and query parameters', () => {
  const url = buildKexpListUrl({
    endpoint: '/plays/',
    offset: 20,
    limit: 15,
    query: {
      ordering: '-airdate',
      status: 'published',
    },
  });

  assert.equal(url.toString(), 'https://api.kexp.org/v2/plays/?offset=20&limit=15&ordering=-airdate&status=published');
});

test('buildKexpItemUrl normalizes endpoint and id', () => {
  const url = buildKexpItemUrl({
    endpoint: 'shows',
    id: '12345',
  });

  assert.equal(url.toString(), 'https://api.kexp.org/v2/shows/12345/');
});

test('buildKexpListUrl rejects invalid endpoint values', () => {
  assert.throws(() => {
    buildKexpListUrl({ endpoint: '../secrets' });
  }, /may only include letters, numbers, underscores, dashes, and forward slashes/);
});

test('buildKexpListUrl rejects negative offset', () => {
  assert.throws(() => {
    buildKexpListUrl({ endpoint: 'plays', offset: -1 });
  }, /non-negative integer/);
});

test('buildKexpListUrl rejects limit > 200', () => {
  assert.throws(() => {
    buildKexpListUrl({ endpoint: 'plays', limit: 201 });
  }, /between 1 and 200/);
});
