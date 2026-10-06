import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tools = process.env.EXAM_SQL_TOOLS;
test('Teacher API grading isolates owners and keeps marks and status correct when edited', {
  skip: !tools && 'Set EXAM_SQL_TOOLS to the external directory containing @electric-sql/pglite@0.5.8',
}, async t => {
  const { PGlite } = await import(pathToFileURL(resolve(tools, 'node_modules/@electric-sql/pglite/dist/index.js')).href);
  const db = new PGlite();
  let checks = 0;
  const teacherA = '11111111-1111-4111-8111-111111111111';
  const teacherB = '22222222-2222-4222-8222-222222222222';
  const missingId = '99999999-9999-4999-8999-999999999999';
  async function query(sql, params = []) { return (await db.query(sql, params)).rows; }
  async function rpc(sql, params = []) { return (await query(sql, params))[0].result; }
  async function asRole(role, user = '') {
    await db.exec('RESET ROLE');
    await query("SELECT set_config('request.jwt.claim.sub', $1, false)", [user]);
    if (role) await db.exec(`SET ROLE ${role}`);
  }
  async function rejects(sql, params, code) {
    try { await db.query(sql, params); assert.fail('Expected SQL failure'); }
    catch (error) { assert.equal(error.code, code, error.message); checks++; }
  }
  function checked(assertion) { assertion(); checks++; }
  const gradeSql = 'SELECT public.api_grade_answer($1,$2,$3,$4,$5) AS result';
  const apiGrade = (token, exam, submission, question, score) => rpc(gradeSql, [token, exam, submission, question, score]);
  const rejectGrade = (token, exam, submission, question, score, code) => rejects(gradeSql, [token, exam, submission, question, score], code);
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
        'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
    `);
    const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);
    const [initialMigration, ...additionalMigrations] = (await fs.readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort();
    await db.exec(await fs.readFile(new URL(initialMigration, migrationDirectory), 'utf8'));
    for (const [id, username] of [[teacherA, 'grading_teacher_a'], [teacherB, 'grading_teacher_b']]) {
      await query('INSERT INTO auth.users VALUES($1,$2,$3)', [id, `${username}@teachers.exam.invalid`, {
        username, first_name: 'معلم', last_name: 'آزمایش', phone: '09123456789',
      }]);
    }
    await asRole('authenticated', teacherA);
    const questions = [
      { type: 'mcq', prompt: '۲+۲؟', points: 2, options: ['۱', '۲', '۳', '۴'], correct: 3 },
      { type: 'essay', prompt: 'پاسخ اول', points: 3.5 },
      { type: 'essay', prompt: 'پاسخ دوم', points: 2 },
    ];
    const exam = await rpc('SELECT public.create_exam($1,$2) AS result', ['آزمون تصحیح API', questions]);
    const otherOwnExam = await rpc('SELECT public.create_exam($1,$2) AS result', ['آزمون دیگر معلم', [questions[1]]]);
    // Issue one key on the old schema so the migration cannot silently extend its permissions.
    const legacyKey = await rpc('SELECT public.issue_api_token() AS result');
    await asRole(null);
    for (const name of additionalMigrations) {
      await db.exec(await fs.readFile(new URL(name, migrationDirectory), 'utf8'));
    }
    await asRole('authenticated', teacherA);
    const key = await rpc('SELECT public.issue_api_token() AS result');
    const expiringKey = await rpc('SELECT public.issue_api_token() AS result');
    await asRole(null);
    for (const [token, expectedScopes] of [
      [legacyKey.token, ['exam:create', 'results:read']],
      [key.token, ['exam:create', 'results:read', 'grade:essay']],
    ]) {
      const row = (await query("SELECT scopes FROM public.api_tokens WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [token]))[0];
      checked(() => assert.deepEqual(row.scopes, expectedScopes));
    }
    await asRole('authenticated', teacherB);
    const otherTeacherExam = await rpc('SELECT public.create_exam($1,$2) AS result', ['آزمون معلم دیگر', [questions[1]]]);
    const otherKey = await rpc('SELECT public.issue_api_token() AS result');
    await asRole('anon');
    const publicExam = await rpc('SELECT public.get_exam($1) AS result', [exam.id]);
    const [mcq, essayOne, essayTwo] = publicExam.questions;
    const otherOwnQuestion = (await rpc('SELECT public.get_exam($1) AS result', [otherOwnExam.id])).questions[0];
    const otherTeacherQuestion = (await rpc('SELECT public.get_exam($1) AS result', [otherTeacherExam.id])).questions[0];
    const answers = { [mcq.id]: { choice: 3 }, [essayOne.id]: { text: 'پاسخ اول دانش‌آموز' }, [essayTwo.id]: { text: 'پاسخ دوم دانش‌آموز' } };
    const submission = await rpc('SELECT public.submit_exam($1,$2,$3,$4) AS result', [exam.id, 'علی', 'اول', answers]);
    const untouchedSubmission = await rpc('SELECT public.submit_exam($1,$2,$3,$4) AS result', [exam.id, 'مریم', 'دوم', answers]);
    const otherTeacherSubmission = await rpc('SELECT public.submit_exam($1,$2,$3,$4) AS result', [otherTeacherExam.id, 'نگار', 'سوم', { [otherTeacherQuestion.id]: { text: 'پاسخ خصوصی' } }]);

    const initial = await rpc('SELECT public.api_results($1,$2) AS result', [key.token, exam.id]);
    checked(() => assert.equal(initial.submissions.length, 2));
    checked(() => assert.ok(initial.submissions.every(s => s.total_score === 2 && s.status === 'pending')));
    const legacyRead = await rpc('SELECT public.api_results($1,$2) AS result', [legacyKey.token, exam.id]);
    checked(() => assert.equal(legacyRead.submissions.length, 2));
    const legacyCreated = await rpc('SELECT public.api_create_exam($1,$2,$3) AS result', [legacyKey.token, 'آزمون کلید قدیمی', [questions[0]]]);
    checked(() => assert.equal(legacyCreated.question_count, 1));
    await rejectGrade(legacyKey.token, exam.id, submission.id, essayOne.id, 1.25, '42501');
    await rejects("UPDATE public.api_tokens SET scopes=ARRAY['grade:essay']", [], '42501');
    // Bearer teacher keys authorize independently of an unrelated Auth session.
    await asRole('authenticated', teacherB);
    await rejects("UPDATE public.api_tokens SET scopes=ARRAY['grade:essay']", [], '42501');
    await asRole('authenticated', teacherA);
    await rejects("UPDATE public.api_tokens SET scopes=ARRAY['exam:create','results:read','grade:essay'] WHERE owner_id=$1", [teacherA], '42501');
    await asRole('authenticated', teacherB);
    const firstGrade = await apiGrade(key.token, exam.id, submission.id, essayOne.id, 1.25);
    checked(() => assert.deepEqual(firstGrade, {
      exam_id: exam.id, submission_id: submission.id, question_id: essayOne.id,
      score: 1.25, total_score: 3.25, status: 'pending',
    }));
    await asRole('anon');
    await rejects('SELECT exam_private.grade_for_owner($1,$2,$3,$4,$5)', [teacherA, exam.id, submission.id, essayOne.id, 3.5], '42501');
    await rejects('SELECT * FROM public.answers', [], '42501');
    await rejects('SELECT public.grade_answer($1,$2,$3)', [submission.id, essayOne.id, 3.5], '42501');
    for (const invalidToken of [null, 'invalid', `exam_${'a'.repeat(96)}`]) {
      await rejectGrade(invalidToken, exam.id, submission.id, essayOne.id, 1, '28000');
    }
    for (const invalidExam of [null, 123456, 1000000000000]) {
      await rejectGrade(key.token, invalidExam, submission.id, essayOne.id, 1, '22023');
    }
    await rejectGrade(otherKey.token, exam.id, submission.id, essayOne.id, 1, '42501');
    await rejectGrade(key.token, otherOwnExam.id, submission.id, essayOne.id, 1, '42501');
    await rejectGrade(key.token, exam.id, otherTeacherSubmission.id, essayOne.id, 1, '42501');
    await rejectGrade(key.token, otherTeacherExam.id, otherTeacherSubmission.id, otherTeacherQuestion.id, 1, '42501');
    await rejectGrade(key.token, exam.id, missingId, essayOne.id, 1, '42501');
    await rejectGrade(key.token, exam.id, submission.id, otherOwnQuestion.id, 1, '42501');
    await rejectGrade(key.token, exam.id, submission.id, otherTeacherQuestion.id, 1, '42501');
    await rejectGrade(key.token, exam.id, submission.id, missingId, 1, '42501');
    await rejectGrade(key.token, 999999999999, submission.id, essayOne.id, 1, '42501');
    await rejectGrade(key.token, exam.id, submission.id, mcq.id, 1, '22023');
    for (const badScore of [-0.01, 3.51, 1.111, null, 'NaN', 'Infinity', '-Infinity']) {
      await rejectGrade(key.token, exam.id, submission.id, essayOne.id, badScore, '22023');
    }
    const afterFailures = await rpc('SELECT public.api_results($1,$2) AS result', [key.token, exam.id]);
    checked(() => assert.equal(afterFailures.submissions.find(s => s.id === submission.id).total_score, 3.25));
    checked(() => assert.equal(afterFailures.submissions.find(s => s.id === submission.id).answers.find(a => a.question_id === essayOne.id).score, 1.25));

    const zeroGrade = await apiGrade(key.token, exam.id, submission.id, essayTwo.id, 0);
    checked(() => assert.equal(zeroGrade.total_score, 3.25));
    checked(() => assert.equal(zeroGrade.status, 'graded', 'Zero is a recorded grade, not an ungraded answer'));
    const increasedGrade = await apiGrade(key.token, exam.id, submission.id, essayOne.id, 3.5);
    checked(() => assert.equal(increasedGrade.total_score, 5.5));
    checked(() => assert.equal(increasedGrade.status, 'graded'));
    const fullGrade = await apiGrade(key.token, exam.id, submission.id, essayTwo.id, 2);
    checked(() => assert.equal(fullGrade.total_score, 7.5));
    const decreasedGrade = await apiGrade(key.token, exam.id, submission.id, essayOne.id, 0);
    checked(() => assert.equal(decreasedGrade.total_score, 4));
    checked(() => assert.equal(decreasedGrade.status, 'graded'));

    await asRole('authenticated', teacherA);
    const legacy = await rpc('SELECT public.grade_answer($1,$2,$3) AS result', [submission.id, essayOne.id, 2.5]);
    checked(() => assert.deepEqual(legacy, { id: submission.id, total_score: 6.5, status: 'graded' }));
    await rejects('SELECT exam_private.grade_for_owner($1,$2,$3,$4,$5)', [teacherA, exam.id, submission.id, essayOne.id, 3.5], '42501');
    await asRole('authenticated', teacherB);
    await rejects('SELECT public.grade_answer($1,$2,$3)', [submission.id, essayOne.id, 3.5], '42501');
    await asRole('anon');
    const updated = await rpc('SELECT public.api_results($1,$2) AS result', [key.token, exam.id]);
    const gradedSubmission = updated.submissions.find(s => s.id === submission.id);
    checked(() => assert.equal(gradedSubmission.total_score, 6.5));
    checked(() => assert.equal(gradedSubmission.answers.find(a => a.question_id === essayOne.id).score, 2.5));
    checked(() => assert.equal(gradedSubmission.answers.find(a => a.question_id === essayTwo.id).score, 2));
    checked(() => assert.equal(gradedSubmission.answers.find(a => a.question_id === mcq.id).score, 2));
    checked(() => assert.equal(updated.submissions.find(s => s.id === untouchedSubmission.id).total_score, 2));
    checked(() => assert.equal(updated.submissions.find(s => s.id === untouchedSubmission.id).status, 'pending'));
    const privateOther = await rpc('SELECT public.api_results($1,$2) AS result', [otherKey.token, otherTeacherExam.id]);
    checked(() => assert.equal(privateOther.submissions[0].total_score, 0));
    checked(() => assert.equal(privateOther.submissions[0].status, 'pending'));

    await asRole(null);
    await query('DELETE FROM public.answers WHERE submission_id=$1 AND question_id=$2', [untouchedSubmission.id, essayTwo.id]);
    await asRole('anon');
    await rejectGrade(key.token, exam.id, untouchedSubmission.id, essayTwo.id, 1, 'P0002');
    await asRole(null);
    await query("UPDATE public.api_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [expiringKey.token]);
    await asRole('anon');
    await rejectGrade(expiringKey.token, exam.id, submission.id, essayOne.id, 1, '28000');
    await asRole('authenticated', teacherA);
    await rpc('SELECT public.revoke_api_tokens() AS result');
    await asRole('anon');
    await rejectGrade(key.token, exam.id, submission.id, essayOne.id, 1, '28000');
    await asRole('authenticated', teacherA);
    const afterRevocation = await rpc('SELECT public.get_results($1) AS result', [exam.id]);
    checked(() => assert.equal(afterRevocation.submissions.find(s => s.id === submission.id).total_score, 6.5));
    t.diagnostic(`${checks} API grading security and update checks passed against actual PostgreSQL with stubbed Supabase Auth.`);
  } finally { await db.close(); }
});
