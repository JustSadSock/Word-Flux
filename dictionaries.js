(function (globalScope, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(globalScope.fetch);
  } else {
    globalScope.WordFluxDictionary = factory(globalScope.fetch);
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function (fetchImpl) {
  const DEFAULT_SOURCES = {
    ru: [
      'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2016/ru/ru_50k.txt'
    ],
    uk: [
      'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2016/uk/uk_50k.txt'
    ]
  };

  const CYRILLIC_TOKEN_RE = /^(?:[\p{Script=Cyrillic}]+)(?:['’ʼ-][\p{Script=Cyrillic}]+)*$/u;

  function normalizeWord(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed || trimmed.length < 1 || trimmed.length > 24) return null;
    if (!CYRILLIC_TOKEN_RE.test(trimmed)) return null;
    if (/^\p{Nd}+$/u.test(trimmed)) return null;
    return trimmed;
  }

  function getFetch(override) {
    const impl = override || fetchImpl;
    if (typeof impl !== 'function') {
      throw new Error('Global fetch is not available. Provide fetchImpl option.');
    }
    return impl.bind(globalThis);
  }

  async function loadDictionaries(lang, extraUrls = [], options = {}) {
    if (lang !== 'ru' && lang !== 'uk') {
      throw new Error('Unsupported language "' + lang + '".');
    }
    const fetchFn = getFetch(options.fetchImpl);
    const defaults = DEFAULT_SOURCES[lang] || [];
    const urls = Array.from(new Set([...defaults, ...extraUrls.filter(Boolean)]));
    if (urls.length === 0) {
      throw new Error('No dictionary URLs provided for ' + lang + '.');
    }

    const responses = await Promise.allSettled(urls.map(url => fetchFn(url, { cache: 'no-store' })));

    const dedupe = new Map();
    let seenAny = false;
    let globalOrder = 0;

    for (let i = 0; i < responses.length; i++) {
      const result = responses[i];
      const url = urls[i];
      if (result.status !== 'fulfilled') {
        console.warn('Dictionary request failed', url, result.reason);
        continue;
      }
      const res = result.value;
      if (!res || typeof res.text !== 'function') {
        console.warn('Dictionary response is invalid for', url);
        continue;
      }
      if (!('ok' in res) || !res.ok) {
        console.warn('Dictionary response not ok', url, res && res.status);
        continue;
      }
      let text;
      try {
        text = await res.text();
      } catch (err) {
        console.warn('Failed reading dictionary', url, err);
        continue;
      }
      if (typeof text !== 'string') continue;
      seenAny = true;
      const lines = text.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const rawLine = lines[lineIndex].trim();
        if (!rawLine) continue;
        const parts = rawLine.split(/\s+/);
        const normalized = normalizeWord(parts[0]);
        if (!normalized) continue;
        const freq = parts.length > 1 ? Number(parts[parts.length - 1]) : NaN;
        const frequency = Number.isFinite(freq) ? freq : 0;
        const order = globalOrder++;
        const entry = { word: normalized, frequency, source: url, sourceIndex: i, order };
        const prev = dedupe.get(normalized);
        if (!prev) {
          dedupe.set(normalized, entry);
        } else {
          if (frequency > prev.frequency || (frequency === prev.frequency && order < prev.order)) {
            dedupe.set(normalized, entry);
          }
        }
      }
    }

    if (!seenAny || dedupe.size === 0) {
      throw new Error('Unable to load any dictionary data for ' + lang + '.');
    }

    const entries = Array.from(dedupe.values());
    entries.sort((a, b) => {
      if (b.frequency !== a.frequency) return b.frequency - a.frequency;
      return a.order - b.order;
    });
    for (let idx = 0; idx < entries.length; idx++) {
      entries[idx] = { ...entries[idx], rank: idx };
    }
    assignStrata(entries);
    return entries;
  }

  function assignStrata(entries) {
    if (!Array.isArray(entries)) return entries;
    const total = entries.length;
    if (!total) return entries;
    const headEnd = Math.max(1, Math.floor(total * 0.05));
    const midEnd = Math.max(headEnd, Math.floor(total * 0.40));
    for (let i = 0; i < total; i++) {
      const entry = entries[i];
      let stratum;
      if (i < headEnd) stratum = 'head';
      else if (i < midEnd) stratum = 'mid';
      else stratum = 'tail';
      entries[i] = { ...entry, stratum };
    }
    return entries;
  }

  function createSampler(words, options = {}) {
    if (!Array.isArray(words) || words.length === 0) {
      throw new Error('Words array must be non-empty.');
    }
    const seed = typeof options.seed === 'number' ? options.seed : (Date.now() % 0xffffffff);
    const windowSize = clampWindowSize(options.windowSize);

    const rng = makeXorshift32(seed);
    const entries = words.map((item, idx) => {
      const frequency = Number.isFinite(item.frequency) ? item.frequency : 0;
      const rank = typeof item.rank === 'number' ? item.rank : idx;
      const source = item.source || 'default';
      return {
        word: item.word,
        frequency,
        rank,
        source,
        sourceIndex: typeof item.sourceIndex === 'number' ? item.sourceIndex : 0,
        stratum: item.stratum
      };
    }).filter(entry => typeof entry.word === 'string');

    if (entries.length === 0) {
      throw new Error('No usable words provided for sampler.');
    }

    entries.sort((a, b) => {
      if (b.frequency !== a.frequency) return b.frequency - a.frequency;
      return a.rank - b.rank;
    });
    if (entries.some(e => !e.stratum)) {
      assignStrata(entries);
    }

    const stratumEntries = {
      head: entries.filter(e => e.stratum === 'head'),
      mid: entries.filter(e => e.stratum === 'mid'),
      tail: entries.filter(e => e.stratum === 'tail')
    };

    const strata = {
      head: makeStratumState(stratumEntries.head, rng),
      mid: makeStratumState(stratumEntries.mid, rng),
      tail: makeStratumState(stratumEntries.tail, rng)
    };

    const weights = [
      { name: 'head', weight: 0.6 },
      { name: 'mid', weight: 0.3 },
      { name: 'tail', weight: 0.1 }
    ];

    const history = [];
    const historySet = new Set();

    function record(word) {
      history.push(word);
      historySet.add(word);
      if (history.length > windowSize) {
        const removed = history.shift();
        historySet.delete(removed);
      }
    }

    function chooseStratum() {
      const roll = rng();
      let cumulative = 0;
      for (const item of weights) {
        cumulative += item.weight;
        if (roll < cumulative) {
          if (strata[item.name].size > 0) {
            return item.name;
          }
        }
      }
      if (strata.head.size > 0) return 'head';
      if (strata.mid.size > 0) return 'mid';
      if (strata.tail.size > 0) return 'tail';
      return null;
    }

    const totalWords = entries.length;

    return function nextWord() {
      if (!totalWords) {
        throw new Error('Sampler has no words to return.');
      }
      const attempts = Math.max(10, windowSize);
      for (let attempt = 0; attempt < attempts; attempt++) {
        const firstStratum = chooseStratum();
        if (!firstStratum) {
          break;
        }
        const ordered = orderStrata(firstStratum);
        for (const name of ordered) {
          const stratum = strata[name];
          if (!stratum || stratum.size === 0) continue;
          const candidate = drawFromStratum(stratum, rng);
          if (!candidate) continue;
          if (!historySet.has(candidate) || historySet.size >= totalWords) {
            record(candidate);
            return candidate;
          }
        }
      }
      // fallback: return any available word ignoring history constraints
      for (const key of ['head', 'mid', 'tail']) {
        const stratum = strata[key];
        if (!stratum || stratum.size === 0) continue;
        const candidate = drawFromStratum(stratum, rng);
        if (candidate) {
          record(candidate);
          return candidate;
        }
      }
      throw new Error('Sampler could not produce a word.');
    };
  }

  function clampWindowSize(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 200;
    return Math.max(1, Math.min(2000, Math.floor(value)));
  }

  function makeXorshift32(seed) {
    let x = seed >>> 0;
    if (x === 0) x = 0x9e3779b9;
    return function () {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 4294967296;
    };
  }

  function shuffleInPlace(array, rng) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = array[i];
      array[i] = array[j];
      array[j] = tmp;
    }
  }

  function makeStratumState(entries, rng) {
    const groups = new Map();
    for (const entry of entries) {
      const key = entry.source || 'default';
      let arr = groups.get(key);
      if (!arr) {
        arr = [];
        groups.set(key, arr);
      }
      arr.push(entry.word);
    }
    for (const arr of groups.values()) {
      shuffleInPlace(arr, rng);
    }
    const cycle = Array.from(groups.keys());
    if (cycle.length > 1) {
      shuffleInPlace(cycle, rng);
    }
    return {
      groups,
      cycle,
      pointer: 0,
      size: entries.length
    };
  }

  function drawFromStratum(stratum, rng) {
    const { groups, cycle } = stratum;
    if (cycle.length === 0) return null;
    const attempts = cycle.length;
    for (let i = 0; i < attempts; i++) {
      if (stratum.pointer >= cycle.length) {
        stratum.pointer = 0;
        if (cycle.length > 1) shuffleInPlace(cycle, rng);
      }
      const source = cycle[stratum.pointer++];
      const pool = groups.get(source);
      if (!pool || pool.length === 0) continue;
      const word = pool[Math.floor(rng() * pool.length)];
      return word;
    }
    return null;
  }

  function orderStrata(primary) {
    if (primary === 'head') return ['head', 'mid', 'tail'];
    if (primary === 'mid') return ['mid', 'head', 'tail'];
    return ['tail', 'head', 'mid'];
  }

  function createBatchSampler(sampler) {
    if (typeof sampler !== 'function') {
      throw new Error('Sampler function is required.');
    }
    return function nextBatch(n) {
      const size = Math.max(1, Math.min(3, Math.floor(n || 1)));
      const result = new Array(size);
      for (let i = 0; i < size; i++) {
        result[i] = sampler();
      }
      return result;
    };
  }

  return {
    DEFAULT_SOURCES,
    loadDictionaries,
    createSampler,
    createBatchSampler
  };
});
