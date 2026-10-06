import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../supabase/functions/exam-api/index.ts';

const apiBase = 'https://example.supabase.co/functions/v1/exam-api';
const token = `exam_${'a'.repeat(96)}`;
const config = { supabaseUrl: 'https://example.supabase.co', publishableKey: 'public-test-key' };
const examId = 453395123456;
const submissionId = '11111111-1111-4111-8111-111111111111';
const questionId = '22222222-2222-4222-8222-222222222222';
const validExam = {
  title: '  آزمون علوم  ',
  questions: [
    { type: 'mcq', prompt: '  آب در چند درجه یخ می‌زند؟ ', points: 1.5, options: [' ۰ ', '۱۰', '۲۰', '۳۰'], correct: 0 },
    { type: 'essay', prompt: 'چرخه آب را توضیح دهید.', points: 2 },
  ],
};
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const createRequest = (body = validExam, overrides = {}) => new Request(`${apiBase}/exams`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
  ...overrides,
});
const gradeRequest = (body = { submission_id: submissionId, question_id: questionId, score: 1.5 }, overrides = {}) =>
  new Request(`${apiBase}/exams/${examId}/grades`, {
    method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), ...overrides,
  });

test('registers and changes an essay score through the owner-scoped grading RPC', async () => {
  let calls = 0;
  const handler = createHandler(config, async (url, options) => {
    calls++;
    assert.equal(url, 'https://example.supabase.co/rest/v1/rpc/api_grade_answer');
    assert.equal(options.headers.apikey, 'public-test-key');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    const args = JSON.parse(options.body);
    assert.deepEqual(args, { p_token: token, p_exam_id: examId, p_submission_id: submissionId,
      p_question_id: questionId, p_score: calls === 1 ? 1.5 : 0 });
    return jsonResponse({ exam_id: examId, submission_id: submissionId, question_id: questionId,
      score: args.p_score, total_score: args.p_score + 2, status: 'graded', hidden_token: token });
  });
  for (const score of [1.5, 0]) {
    const response = await handler(gradeRequest({ submission_id: submissionId, question_id: questionId, score }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { exam_id: examId, submission_id: submissionId,
      question_id: questionId, score, total_score: score + 2, status: 'graded' });
  }
  assert.equal(calls, 2);
});

test('grading rejects malformed IDs, scores and unsupported fields before the RPC', async () => {
  const handler = createHandler(config, () => assert.fail('RPC must not be called'));
  const grade = { submission_id: submissionId, question_id: questionId, score: 1.5 };
  const invalid = [null, [], {}, { ...grade, owner_id: 'other' }, { ...grade, teacher_id: 'other' },
    { ...grade, submission_id: 'student-name' }, { ...grade, question_id: 'question-number' },
    { ...grade, submission_id: null }, { ...grade, question_id: `${questionId} extra` },
    ...[-0.01, 100.01, 0.001, '1.5', null, undefined].map(score => ({ ...grade, score }))];
  for (const body of invalid) assert.equal((await handler(gradeRequest(body))).status, 400);
  assert.equal((await handler(gradeRequest(grade, { headers: { 'content-type': 'application/json' } }))).status, 401);
  assert.equal((await handler(gradeRequest(grade, { headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await handler(gradeRequest(grade, { body: '{' }))).status, 400);
  assert.equal((await handler(gradeRequest(grade, { method: 'POST' }))).status, 405);
  for (const path of ['/exams/453395/grades', '/exams/1234567890123/grades', '/exams/unknown/grades']) {
    assert.equal((await handler(new Request(`${apiBase}${path}`, { method: 'PATCH' }))).status, 404);
  }
});

test('grading preserves sanitized token, ownership, bounds and missing-answer errors', async () => {
  for (const [code, expected, errorCode] of [['28000', 401, 'unauthorized'], ['42501', 403, 'forbidden'],
    ['22023', 400, 'invalid_input'], ['P0002', 404, 'not_found'], ['XX000', 502, 'upstream_error']]) {
    const handler = createHandler(config, async () => jsonResponse({ code, message: `private ${token}` }, 400));
    const result = await handler(gradeRequest());
    assert.equal(result.status, expected);
    const body = await result.json();
    assert.equal(body.error.code, errorCode);
    assert.equal(JSON.stringify(body).includes(token), false);
  }
});

test('grading never accepts a mismatched or incomplete database acknowledgement', async () => {
  const result = { exam_id: examId, submission_id: submissionId, question_id: questionId,
    score: 1.5, total_score: 3.5, status: 'pending' };
  for (const invalid of [null, [], { id: submissionId, total_score: 3.5, status: 'graded' },
    { ...result, exam_id: 999999999999 }, { ...result, submission_id: questionId },
    { ...result, question_id: submissionId }, { ...result, score: 2 }, { ...result, total_score: 1001 },
    { ...result, total_score: 1 }, { ...result, total_score: null }, { ...result, status: 'unknown' }]) {
    const response = await createHandler(config, async () => jsonResponse(invalid))(gradeRequest());
    assert.equal(response.status, 502);
  }
});

test('creates an owner-scoped exam and returns the GitHub Pages student link', async () => {
  let calls = 0;
  const handler = createHandler(config, async (url, options) => {
    calls++;
    assert.equal(url, 'https://example.supabase.co/rest/v1/rpc/api_create_exam');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.apikey, 'public-test-key');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    const args = JSON.parse(options.body);
    assert.equal(args.p_token, token);
    assert.equal(args.p_title, 'آزمون علوم');
    assert.equal(args.p_questions[0].options[0], '۰');
    assert.equal(args.p_questions[0].correct, 0);
    assert.equal(args.p_questions[1].type, 'essay');
    return jsonResponse({ id: examId, title: args.p_title, question_count: 2, total_points: 3.5, hidden_token: token });
  });
  const result = await handler(createRequest());
  assert.equal(result.status, 201);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), {
    id: examId, title: 'آزمون علوم', question_count: 2, total_points: 3.5,
    url: `https://mozdbaranarshiya.github.io/exam/id/${examId}`,
  });
  assert.equal(calls, 1);
});

test('gets grades with the authenticated teacher token through the results RPC', async () => {
  const data = { id: examId, title: 'آزمون علوم', questions: validExam.questions, submissions: [{ first_name: 'سارا', last_name: 'رضایی', score: 1.5 }] };
  const handler = createHandler(config, async (url, options) => {
    assert.equal(url, 'https://example.supabase.co/rest/v1/rpc/api_results');
    assert.deepEqual(JSON.parse(options.body), { p_token: token, p_exam_id: examId });
    return jsonResponse(data);
  });
  const result = await handler(new Request(`${apiBase}/exams/${examId}/results`, { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), data);
});

test('missing or malformed bearer authentication is rejected before the RPC', async () => {
  const handler = createHandler(config, () => assert.fail('RPC must not be called'));
  for (const authorization of ['', 'Basic abc', 'Bearer short', `Bearer ${token} extra`]) {
    const response = await handler(createRequest(validExam, { headers: { authorization, 'content-type': 'application/json' } }));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'unauthorized');
  }
});

test('database token, ownership, input, and unexpected errors are sanitized', async () => {
  for (const [code, expected] of [['28000', 401], ['42501', 403], ['22023', 400], ['XX000', 502]]) {
    const handler = createHandler(config, async () => jsonResponse({ code, message: `sensitive ${token}`, details: 'private database information' }, 400));
    const result = await handler(createRequest());
    assert.equal(result.status, expected);
    const body = await result.text();
    assert.equal(body.includes(token), false);
    assert.equal(body.includes('private database information'), false);
  }
});

test('only documented methods and twelve-digit exam routes reach the database', async () => {
  const handler = createHandler(config, () => assert.fail('RPC must not be called'));
  const response = await handler(new Request(`${apiBase}/exams`, { method: 'GET' }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
  for (const path of ['/unknown', '/exams/invalid/results', '/exams/453395/results', '/exams/1234567890123/results']) {
    assert.equal((await handler(new Request(`${apiBase}${path}`))).status, 404);
  }
});

test('invalid exam contents cannot bypass gateway validation', async () => {
  const handler = createHandler(config, () => assert.fail('RPC must not be called'));
  const cases = [
    [], {}, { ...validExam, teacher_id: 'someone-else' }, { ...validExam, title: '' },
    { ...validExam, title: 'a'.repeat(201) }, { ...validExam, questions: [] },
    { ...validExam, questions: Array(101).fill(validExam.questions[1]) },
    ...[
      { type: 'unknown', prompt: 'Q', points: 1 },
      { type: 'essay', prompt: '', points: 1 },
      { type: 'essay', prompt: 'a'.repeat(5001), points: 1 },
      { type: 'essay', prompt: 'Q', points: 0 },
      { type: 'essay', prompt: 'Q', points: 100.01 },
      { type: 'essay', prompt: 'Q', points: 0.001 },
      { type: 'essay', prompt: 'Q', points: '2' },
      { type: 'essay', prompt: 'Q', points: 1, correct: 0 },
      { type: 'essay', prompt: 'Q', points: 1, options: null },
      { type: 'mcq', prompt: 'Q', points: 1, options: ['A', 'B', 'C'], correct: 0 },
      { type: 'mcq', prompt: 'Q', points: 1, options: ['A', '', 'C', 'D'], correct: 0 },
      { type: 'mcq', prompt: 'Q', points: 1, options: ['A', 'B', 'C', 'D'], correct: 4 },
      { type: 'mcq', prompt: 'Q', points: 1, options: ['A', 'B', 'C', 'D'], correct: 1.5 },
    ].map((question) => ({ title: 'Q', questions: [question] })),
    { title: 'Q', questions: Array(11).fill({ type: 'essay', prompt: 'Q', points: 100 }) },
  ];
  for (const body of cases) assert.equal((await handler(createRequest(body))).status, 400, JSON.stringify(body).slice(0, 100));
});

test('media types, malformed JSON, and invalid UTF-8 are rejected', async () => {
  const handler = createHandler(config, () => assert.fail('RPC must not be called'));
  assert.equal((await handler(createRequest(validExam, { headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await handler(createRequest(validExam, { body: '{' }))).status, 400);
  assert.equal((await handler(createRequest(validExam, { body: new Uint8Array([0xff]) }))).status, 400);
});

test('the body limit is enforced with and without a trusted Content-Length', async () => {
  const handler = createHandler(config, () => assert.fail('RPC must not be called'));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const declared = await handler(createRequest(validExam, { headers: { ...headers, 'content-length': '262145' } }));
  assert.equal(declared.status, 413);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(128 * 1024));
      controller.enqueue(new Uint8Array(128 * 1024 + 1));
      controller.close();
    },
  });
  const streamed = await handler(new Request(`${apiBase}/exams`, { method: 'POST', headers, body: stream, duplex: 'half' }));
  assert.equal(streamed.status, 413);
});

test('CORS supports the website and rejects unconfigured browser origins', async () => {
  const handler = createHandler(config, () => assert.fail('RPC must not be called'));
  const response = await handler(new Request(`${apiBase}/exams`, { method: 'OPTIONS', headers: { origin: 'https://mozdbaranarshiya.github.io' } }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mozdbaranarshiya.github.io');
  assert.ok(response.headers.get('access-control-allow-methods').split(', ').includes('PATCH'));
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  const blocked = await handler(new Request(`${apiBase}/exams`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
});

test('unconfigured runtime and transport failures do not expose internal errors', async () => {
  assert.equal((await createHandler({}, () => assert.fail('RPC must not be called'))(createRequest())).status, 503);
  const failed = await createHandler(config, async () => { throw new Error(`private ${token}`); })(createRequest());
  assert.equal(failed.status, 502);
  assert.equal((await failed.text()).includes(token), false);
});

test('an unexpected RPC shape or mismatched exam is never returned as a valid result', async () => {
  for (const result of [null, [], { id: 123, title: 'Q', question_count: 1, total_points: 1 }]) {
    assert.equal((await createHandler(config, async () => jsonResponse(result))(createRequest())).status, 502);
  }
  const handler = createHandler(config, async () => jsonResponse({ id: 999999999999, questions: [], submissions: [] }));
  const response = await handler(new Request(`${apiBase}/exams/${examId}/results`, { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(response.status, 502);
});
