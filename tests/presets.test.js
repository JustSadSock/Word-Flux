const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const indexHtml = path.join(rootDir, 'index.html');

const presets = [
  { id: 'ru-lexicon', file: 'ru.txt', minWords: 10000 },
  { id: 'uk-lexicon', file: 'uk.txt', minWords: 10000 },
  { id: 'en-lexicon', file: 'en.txt', minWords: 10000 }
];

test('preset dictionary files contain at least 10k unique words', () => {
  for (const preset of presets) {
    const filePath = path.join(dataDir, preset.file);
    assert.ok(fs.existsSync(filePath), `Файл ${preset.file} отсутствует`);
    const raw = fs.readFileSync(filePath, 'utf8');
    const words = raw.split(/\r?\n/).map(w => w.trim()).filter(Boolean);
    assert.ok(words.length >= preset.minWords, `${preset.id} содержит только ${words.length} слов`);
    const unique = new Set(words.map(w => w.toLowerCase()));
    assert.strictEqual(unique.size, words.length, `${preset.id} содержит повторы`);
    for (const sample of words.slice(0, 100)) {
      assert.ok(!/[0-9]/.test(sample), `${preset.id} содержит цифры в слове "${sample}"`);
    }
  }
});

test('preset identifiers wired into index.html', () => {
  const html = fs.readFileSync(indexHtml, 'utf8');
  for (const preset of presets) {
    assert.ok(html.includes(`data-preset="${preset.id}"`), `Нет кнопки для пресета ${preset.id}`);
    assert.ok(html.includes(`"${preset.id}"`), `Нет объявления пресета ${preset.id}`);
  }
});
