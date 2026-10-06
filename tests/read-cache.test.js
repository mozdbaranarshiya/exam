import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadCache } from '../read-cache.js';

test('read cache shares pending requests, expires, and refreshes explicitly', async () => {
  let time = 0, calls = 0;
  const cache = createReadCache({ ttl: 15, now: () => time });
  const loader = async () => ++calls;
  assert.deepEqual(await Promise.all([cache.get('exams', loader), cache.get('exams', loader)]), [1, 1]);
  time = 14;
  assert.equal(await cache.get('exams', loader), 1);
  assert.equal(await cache.get('exams', loader, true), 2);
  time = 30;
  assert.equal(await cache.get('exams', loader), 3);
  cache.invalidate('exams');
  assert.equal(await cache.get('exams', loader), 4);
});

test('failed reads are retried and session clearing cannot retain an older account response', async () => {
  const cache = createReadCache();
  await assert.rejects(cache.get('results', () => { throw new Error('offline'); }), /offline/);
  assert.equal(await cache.get('results', async () => 'recovered'), 'recovered');
  let finish;
  const previousAccount = cache.get('exams', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  cache.clear();
  assert.equal(await cache.get('exams', async () => 'new account'), 'new account');
  finish('previous account');
  assert.equal(await previousAccount, 'previous account');
  assert.equal(await cache.get('exams', () => { throw new Error('unexpected request'); }), 'new account');
});
