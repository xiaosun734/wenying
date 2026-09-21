import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateSeed } from '../server/media-task.mjs';

test('candidateSeed 只在显式传 seed 时固定，否则交给 provider 随机', () => {
  assert.equal(candidateSeed({}, 0), undefined);
  assert.equal(candidateSeed({ seed: null }, 0), undefined);
  assert.equal(candidateSeed({ seed: null }, 3), undefined);
  assert.equal(candidateSeed({ seed: '' }, 0), undefined);
  assert.equal(candidateSeed({ seed: 'abc' }, 0), undefined);
  assert.equal(candidateSeed(undefined, 0), undefined);

  assert.equal(candidateSeed({ seed: 0 }, 0), 0);
  assert.equal(candidateSeed({ seed: 0 }, 2), 2);
  assert.equal(candidateSeed({ seed: 101 }, 0), 101);
  assert.equal(candidateSeed({ seed: 101 }, 3), 104);
  assert.equal(candidateSeed({ seed: '77' }, 1), 78);
});
