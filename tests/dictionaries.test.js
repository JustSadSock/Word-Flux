const test = require('node:test');
const assert = require('node:assert/strict');

const { loadDictionaries, createSampler, createBatchSampler, DEFAULT_SOURCES } = require('../dictionaries');

const RU_URL = DEFAULT_SOURCES.ru[0];
const UK_URL = DEFAULT_SOURCES.uk[0];

test('loadDictionaries parses, normalizes and deduplicates words per language', async () => {
  const payloads = new Map([
    [RU_URL, `Думать 500\nвести 300\nкино 200\n12345 100\n`],
    [UK_URL, `думати 400\nвести 100\nмова-2 50\nсвіт 250\n`]
  ]);

  const fetchImpl = async (url) => {
    if (!payloads.has(url)) {
      throw new Error('Unexpected URL ' + url);
    }
    return {
      ok: true,
      async text() {
        return payloads.get(url);
      }
    };
  };

  const ruEntries = await loadDictionaries('ru', [], { fetchImpl });
  assert.ok(ruEntries.length >= 3, 'должны остаться минимум три слова');
  const words = ruEntries.map(e => e.word);
  assert.ok(words.includes('думать'));
  assert.ok(words.includes('вести'));
  assert.ok(words.includes('кино'));
  assert.ok(!words.includes('12345'));
  const вести = ruEntries.find(e => e.word === 'вести');
  assert.equal(вести.source, RU_URL);
  assert.equal(вести.frequency, 300);
  assert.equal(ruEntries[0].stratum, 'head');

  const ukEntries = await loadDictionaries('uk', [], { fetchImpl });
  const ukWords = ukEntries.map(e => e.word);
  assert.ok(ukWords.includes('думати'));
  assert.ok(ukWords.includes('світ'));
  assert.ok(!ukWords.includes('мова-2'));
  assert.equal(ukEntries[0].source, UK_URL);
});

test('createSampler respects stratified weights and anti-repeat window', () => {
  const entries = [];
  for (let i = 0; i < 60; i++) {
    entries.push({
      word: `head-${i}`,
      frequency: 1000 - i,
      rank: i,
      source: i % 2 === 0 ? 'A' : 'B',
      stratum: 'head'
    });
  }
  for (let i = 0; i < 30; i++) {
    entries.push({
      word: `mid-${i}`,
      frequency: 500 - i,
      rank: 60 + i,
      source: i % 2 === 0 ? 'A' : 'B',
      stratum: 'mid'
    });
  }
  for (let i = 0; i < 10; i++) {
    entries.push({
      word: `tail-${i}`,
      frequency: 100 - i,
      rank: 90 + i,
      source: i % 2 === 0 ? 'A' : 'B',
      stratum: 'tail'
    });
  }

  const sampler = createSampler(entries, { seed: 12345, windowSize: 40 });
  const total = 1200;
  const counts = { head: 0, mid: 0, tail: 0 };
  const history = [];
  for (let i = 0; i < total; i++) {
    const word = sampler();
    history.push(word);
    if (history.length > 40) {
      const recent = history.slice(-40);
      const unique = new Set(recent);
      assert.equal(unique.size, recent.length, 'повтор в окне анти-повторов');
    }
    if (word.startsWith('head-')) counts.head++;
    else if (word.startsWith('mid-')) counts.mid++;
    else if (word.startsWith('tail-')) counts.tail++;
  }

  const headShare = counts.head / total;
  const midShare = counts.mid / total;
  const tailShare = counts.tail / total;
  assert.ok(headShare > 0.5 && headShare < 0.7, 'head strata weight out of bounds');
  assert.ok(midShare > 0.2 && midShare < 0.4, 'mid strata weight out of bounds');
  assert.ok(tailShare > 0.05 && tailShare < 0.2, 'tail strata weight out of bounds');
});

test('createBatchSampler returns batches of limited size', () => {
  let counter = 0;
  const sampler = () => `w${counter++}`;
  const batchSampler = createBatchSampler(sampler);
  assert.deepEqual(batchSampler(2), ['w0', 'w1']);
  assert.deepEqual(batchSampler(5), ['w2', 'w3', 'w4']);
  assert.deepEqual(batchSampler(0), ['w5']);
});
