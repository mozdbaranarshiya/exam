import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsername, normalizeDigits, validateQuestions, examLink } from '../core.js';

const mcq = () => ({ type: 'mcq', prompt: '  حاصل دو به‌علاوه دو؟  ', points: '2.5', options: [' یک ', ' دو ', ' سه ', ' چهار '], correct: 3 });
const essay = () => ({ type: 'essay', prompt: ' پاسخ را توضیح دهید. ', points: 7.5 });

test('usernames are canonical and reject unsupported or ambiguous characters', () => {
  assert.equal(normalizeUsername('  Teacher_23  '), 'teacher_23');
  assert.equal(normalizeUsername('a'.repeat(32)), 'a'.repeat(32));
  for (const value of ['ab', 'a'.repeat(33), 'معلم', 'name space', 'name@school', 'a/b', '<script>']) {
    assert.throws(() => normalizeUsername(value), Error, value);
  }
});

test('Persian and Arabic numerals convert without changing other text', () => {
  assert.equal(normalizeDigits('۰۹۱۲٣٤٥٦۷۸۹'), '09123456789');
  assert.equal(normalizeDigits('بارم ۲.۵ / ١٠'), 'بارم 2.5 / 10');
  assert.equal(normalizeDigits('0123456789 + text'), '0123456789 + text');
});

test('questions normalize prompts, options and numeric points without mutating drafts', () => {
  const questions = [mcq(), essay()];
  const snapshot = structuredClone(questions);
  assert.deepEqual(validateQuestions(questions), [
    { type: 'mcq', prompt: 'حاصل دو به‌علاوه دو؟', points: 2.5, options: ['یک', 'دو', 'سه', 'چهار'], correct: 3 },
    { type: 'essay', prompt: 'پاسخ را توضیح دهید.', points: 7.5 },
  ]);
  assert.deepEqual(questions, snapshot);
});

test('questions enforce limits and require a correct choice for multiple choice', () => {
  assert.throws(() => validateQuestions([]));
  assert.throws(() => validateQuestions(Array.from({ length: 101 }, essay)));
  assert.equal(validateQuestions(Array.from({ length: 100 }, essay)).length, 100);
  const badQuestions = [
    { ...essay(), prompt: ' ' },
    { ...essay(), prompt: 'x'.repeat(5001) },
    { ...essay(), points: 0 },
    { ...essay(), points: -1 },
    { ...essay(), points: Infinity },
    { ...essay(), points: 'invalid' },
    { ...essay(), points: 100.1 },
    { ...essay(), type: 'unknown' },
    { ...mcq(), correct: null },
    { ...mcq(), correct: -1 },
    { ...mcq(), correct: 4 },
    { ...mcq(), correct: 1.5 },
    { ...mcq(), options: ['a', 'b', 'c'] },
    { ...mcq(), options: ['a', 'b', 'c', ' '] },
  ];
  for (const question of badQuestions) assert.throws(() => validateQuestions([question]), Error, JSON.stringify(question));
  assert.equal(validateQuestions([{ ...essay(), points: 100 }])[0].points, 100);
});

test('exam links support GitHub Pages subpaths and reject unsafe identifiers', () => {
  assert.equal(examLink('https://mozdbaranarshiya.github.io', '/exam/', 453395), 'https://mozdbaranarshiya.github.io/exam/id/453395');
  assert.equal(examLink('http://localhost:5174', '/', '123456'), 'http://localhost:5174/id/123456');
  for (const id of ['', 'a1', '../123', '123?key=x', '123#fragment', '<svg>', '۱۲۳۴', -1, 1.5, Infinity]) {
    assert.throws(() => examLink('https://example.com', '/exam/', id), Error, String(id));
  }
});
