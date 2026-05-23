import assert from 'node:assert/strict';
import test from 'node:test';
import { buildKexpItemUrl, buildKexpListUrl } from './kexpClient.js';

test('buildKexpListUrl adds pagination and query parameters', () => {
  const url = buildKexpListUrl({
    endpoint: '/plays/',
    page: 2,
    limit: 15,
    query: {
      ordering: '-airdate',
      status: 'published',
    },
  });

  assert.equal(url.toString(), 'https://api.kexp.org/v2/plays/?page=2&limit=15&ordering=-airdate&status=published');
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
