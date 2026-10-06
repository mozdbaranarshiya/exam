import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

// Optional tooling lives outside the application checkout; no production dependency.
// npm install --prefix /tmp/exam-sql-tools --cache /tmp/exam-npm-cache --no-audit --no-fund @electric-sql/pglite@0.5.8
// EXAM_SQL_TOOLS=/tmp/exam-sql-tools node --test tests/database.test.mjs
const tools = process.env.EXAM_SQL_TOOLS;
test('PostgreSQL migration, teacher isolation, anonymous submission, grading and API token revocation', {
  skip: !tools && 'Set EXAM_SQL_TOOLS to the external directory containing @electric-sql/pglite@0.5.8',
}, async t => {
  const { PGlite } = await import(pathToFileURL(resolve(tools, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
  const db = new PGlite();
  try {
    await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
      'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
    `);
    await db.exec(await fs.readFile(new URL('../supabase/migrations/202610050001_initial.sql', import.meta.url), 'utf8'));
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const questions = [
      { type: 'mcq', prompt: 'جمع دو و دو؟', points: 2, options: ['1', '2', '3', '4'], correct: 3 },
      { type: 'essay', prompt: 'توضیح دهید', points: 3.5 },
    ];
    let checks = 0;
    async function query(sql, params = []) { return (await db.query(sql, params)).rows; }
    async function asRole(role, user = '') {
      await db.exec('RESET ROLE');
      await query("SELECT set_config('request.jwt.claim.sub', $1, false)", [user]);
      await db.exec(`SET ROLE ${role}`);
    }
    async function rejects(sql, params, code) {
      try { await db.query(sql, params); assert.fail('Expected SQL failure'); }
      catch (error) { assert.equal(error.code, code, error.message); checks++; }
    }
    async function rpc(sql, params) { const r = await query(sql, params); return r[0].result; }

    for (const [id, name] of [[a, 'teacher_one'], [b, 'teacher_two']]) {
      await query('INSERT INTO auth.users VALUES($1, $2, $3)', [id, `${name}@teachers.exam.invalid`, {
        username: name, first_name: 'نام', last_name: 'خانوادگی', phone: '09123456789',
      }]);
    }
    await rejects('INSERT INTO auth.users VALUES($1,$2,$3)', ['33333333-3333-4333-8333-333333333333', 'bad@teachers.exam.invalid', {}], '22023');

    await asRole('authenticated', a);
    const exam = await rpc('SELECT public.create_exam($1,$2) AS result', ['آزمون اول', questions]);
    assert.equal(String(exam.id).length, 12); assert.equal(exam.total_points, 5.5); checks++;
    const listed = await rpc('SELECT public.list_exams() AS result'); assert.equal(listed.length, 1); checks++;
    assert.equal((await query('SELECT * FROM public.teacher_profiles')).length, 1); checks++;
    await rejects('SELECT * FROM public.questions', [], '42501');
    await rejects('SELECT exam_private.create_exam_for_owner($1,$2,$3)', [b, 'فریب', questions], '42501');
    await rejects('SELECT public.create_exam($1,$2)', ['بد', [{ ...questions[0], points: -1 }]], '22023');
    await rejects('SELECT public.create_exam($1,$2)', ['بد', [{ ...questions[0], correct: 4 }]], '22023');
    await rejects('SELECT public.create_exam($1,$2)', ['بد', [{ ...questions[0], correct: null }]], '22023');
    await rejects('SELECT public.create_exam($1,$2)', ['بد', [{ ...questions[0], points: 0.001 }]], '22023');
    await rejects('SELECT public.create_exam($1,$2)', ['بد', [{ ...questions[1], correct: 0 }]], '22023');

    const key = await rpc('SELECT public.issue_api_token() AS result'); assert.match(key.token, /^exam_[a-f0-9]{96}$/); checks++;
    await asRole('anon');
    await rejects('SELECT * FROM public.teacher_profiles', [], '42501');
    await rejects('SELECT * FROM public.questions', [], '42501');
    await rejects('SELECT * FROM public.submissions', [], '42501');
    await rejects('SELECT * FROM public.api_tokens', [], '42501');
    await rejects('SELECT public.create_exam($1,$2)', ['فریب', questions], '42501');
    await rejects('SELECT public.get_results($1)', [exam.id], '42501');
    const studentExam = await rpc('SELECT public.get_exam($1) AS result', [exam.id]);
    assert.equal(studentExam.questions.length, 2);
    assert.ok(studentExam.questions.every(q => !('correct' in q))); checks++;
    const [q1, q2] = studentExam.questions;
    const answers = { [q1.id]: { choice: 3 }, [q2.id]: { text: 'پاسخ دانش‌آموز' } };
    await rejects('SELECT public.submit_exam($1,$2,$3,$4)', [exam.id, 'علی', 'احمدی', { [q1.id]: { choice: 3 } }], '22023');
    await rejects('SELECT public.submit_exam($1,$2,$3,$4)', [exam.id, 'علی', 'احمدی', { ...answers, [q1.id]: { choice: 4 } }], '22023');
    await rejects('SELECT public.submit_exam($1,$2,$3,$4)', [exam.id, 'علی', 'احمدی', { ...answers, [q2.id]: { text: 'ok', score: 3.5 } }], '22023');
    const receipt = await rpc('SELECT public.submit_exam($1,$2,$3,$4) AS result', [exam.id, 'علی', 'احمدی', answers]);
    assert.equal(receipt.status, 'received'); assert.ok(!('total_score' in receipt)); checks++;
    const apiResult = await rpc('SELECT public.api_results($1,$2) AS result', [key.token, exam.id]);
    assert.equal(apiResult.submissions[0].total_score, 2); assert.equal(apiResult.submissions[0].status, 'pending'); checks++;
    const apiExam = await rpc('SELECT public.api_create_exam($1,$2,$3) AS result', [key.token, 'آزمون API', [questions[0]]]);
    assert.equal(apiExam.question_count, 1); checks++;
    await rejects('SELECT public.api_results($1,$2)', ['exam_' + 'a'.repeat(96), exam.id], '28000');

    await asRole('authenticated', b);
    assert.equal((await rpc('SELECT public.list_exams() AS result')).length, 0); checks++;
    await rejects('SELECT public.get_results($1)', [exam.id], '42501');
    await rejects('SELECT public.grade_answer($1,$2,$3)', [receipt.id, q2.id, 3], '42501');
    const otherKey = await rpc('SELECT public.issue_api_token() AS result');
    await rejects('SELECT public.api_results($1,$2)', [otherKey.token, exam.id], '42501');

    await asRole('authenticated', a);
    let result = await rpc('SELECT public.get_results($1) AS result', [exam.id]);
    assert.equal(result.submissions.length, 1, 'Invalid submissions must roll back atomically'); checks++;
    await rejects('SELECT public.grade_answer($1,$2,$3)', [receipt.id, q2.id, 4], '22023');
    await rejects('SELECT public.grade_answer($1,$2,$3)', [receipt.id, q2.id, -1], '22023');
    await rejects('SELECT public.grade_answer($1,$2,$3)', [receipt.id, q2.id, 'NaN'], '22023');
    await rejects('SELECT public.grade_answer($1,$2,$3)', [receipt.id, q1.id, 1], '22023');
    const graded = await rpc('SELECT public.grade_answer($1,$2,$3) AS result', [receipt.id, q2.id, 2.5]);
    assert.equal(graded.total_score, 4.5); assert.equal(graded.status, 'graded'); checks++;
    const revoke = await rpc('SELECT public.revoke_api_tokens() AS result'); assert.equal(revoke.revoked, 1); checks++;
    await asRole('anon');
    await rejects('SELECT public.api_results($1,$2)', [key.token, exam.id], '28000');

    await asRole('authenticated', a);
    const allMCQ = await rpc('SELECT public.get_exam($1) AS result', [apiExam.id]);
    await asRole('anon');
    const wrong = await rpc('SELECT public.submit_exam($1,$2,$3,$4) AS result', [apiExam.id, 'نگار', 'حسینی', { [allMCQ.questions[0].id]: { choice: 0 } }]);
    await asRole('authenticated', a);
    result = await rpc('SELECT public.get_results($1) AS result', [apiExam.id]);
    assert.equal(result.submissions[0].status, 'graded'); assert.equal(result.submissions[0].total_score, 0); checks++;

    await asRole('authenticated', '');
    await rejects('SELECT public.list_exams()', [], '28000');
    await asRole('anon');
    await rejects('SELECT public.get_exam($1)', [999999999999], 'P0002');
    assert.equal(checks, 41);
    t.diagnostic(`${checks} database workflow/security checks passed against actual PostgreSQL with stubbed Supabase Auth.`);
  } finally { await db.close(); }
});
