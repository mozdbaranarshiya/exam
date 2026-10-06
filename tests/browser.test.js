import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Keep optional browser tooling outside the static application checkout.
// EXAM_BROWSER_TOOLS=/tmp/exam-test-tools EXAM_BROWSER_EXECUTABLE=/usr/bin/chromium npm test
const tools = process.env.EXAM_BROWSER_TOOLS;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:5174';
const site = `${origin}/${repository.split('/').at(-1)}/`;
const examId = 453395;
const mcqId = '11111111-1111-4111-8111-111111111111';
const essayId = '22222222-2222-4222-8222-222222222222';
const submissionId = '33333333-3333-4333-8333-333333333333';
const malicious = '<img src=x onerror="window.__xss=1">';
const session = { access_token: 'test-teacher-access', refresh_token: 'test-teacher-refresh', expires_in: 3600, user: { id: '44444444-4444-4444-8444-444444444444' } };

async function screenshot(page, name) {
  if (!process.env.EXAM_BROWSER_SCREENSHOTS) return;
  await mkdir(process.env.EXAM_BROWSER_SCREENSHOTS, { recursive: true });
  const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  // Full-page Chromium capture includes fixed elements at the current scroll
  // offset; capture from the top so hidden keyboard-only controls stay hidden.
  await page.evaluate(() => scrollTo(0, 0));
  try { await page.screenshot({ path: resolve(process.env.EXAM_BROWSER_SCREENSHOTS, name), fullPage: true }); }
  finally { await page.evaluate(({ x, y }) => scrollTo(x, y), scroll); }
}

async function serve() {
  const server = spawn('python3', ['-m', 'http.server', '5174', '--bind', '127.0.0.1'], { cwd: dirname(repository), stdio: 'ignore' });
  let failure;
  server.on('error', e => { failure = e; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    if (server.exitCode !== null) throw new Error('Browser-test HTTP server failed; port 5174 must be free.');
    try { if ((await fetch(site)).ok) return server; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  server.kill();
  throw new Error('Browser-test HTTP server did not become ready.');
}

function fakeBackend() {
  const state = { calls: [], exam: null, submission: null, essayScore: null, authSession: session };
  const results = () => ({
    id: examId, title: state.exam.title, questions: state.exam.questions,
    submissions: state.submission ? [{
      id: submissionId, first_name: state.submission.p_first_name, last_name: state.submission.p_last_name,
      total_score: 2.5 + (state.essayScore ?? 0), max_score: 10,
      status: state.essayScore === null ? 'pending' : 'graded', created_at: '2026-10-05T00:00:00Z',
      answers: state.exam.questions.map(q => ({
        question_id: q.id, type: q.type, prompt: q.prompt, points: q.points,
        ...state.submission.p_answers[q.id], ...(q.type === 'mcq' ? { correct: q.correct, score: 2.5 } : { score: state.essayScore }),
      })),
    }] : [],
  });
  async function install(context) {
    await context.route('https://*.supabase.co/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const body = request.postDataJSON() || {};
      const call = { path: url.pathname, query: url.search, body, authorization: request.headers().authorization };
      state.calls.push(call);
      let data;
      if (url.pathname === '/auth/v1/signup' || url.pathname === '/auth/v1/token') data = state.authSession;
      else if (url.pathname === '/auth/v1/logout') data = {};
      else {
        const operation = url.pathname.split('/').at(-1);
        if (!['get_exam', 'submit_exam'].includes(operation)) assert.equal(call.authorization, `Bearer ${state.authSession.access_token}`, `Teacher authentication required for ${operation}`);
        switch (operation) {
          case 'list_exams': data = state.exam ? [{ id: examId, title: state.exam.title, total_points: 10, question_count: 2, submission_count: state.submission ? 1 : 0, created_at: '2026-10-05T00:00:00Z' }] : []; break;
          case 'create_exam':
            state.exam = { id: examId, title: body.p_title, questions: body.p_questions.map((q, i) => ({ ...q, id: i ? essayId : mcqId })) };
            data = { id: examId, title: state.exam.title, created_at: '2026-10-05T00:00:00Z', question_count: 2, total_points: 10 }; break;
          case 'get_exam':
            assert.equal(body.p_exam_id, examId);
            assert.equal(call.authorization, undefined, 'Public exam reads must not send teacher credentials');
            data = { id: examId, title: state.exam.title, questions: state.exam.questions.map(({ correct, ...q }) => ({ ...q, options: q.options ?? null })) }; break;
          case 'submit_exam':
            assert.equal(body.p_exam_id, examId);
            assert.equal(call.authorization, undefined, 'Student submissions must not send teacher credentials');
            state.submission = body; data = { id: submissionId, exam_id: examId, status: 'received' }; break;
          case 'get_results': assert.equal(body.p_exam_id, examId); data = results(); break;
          case 'grade_answer':
            assert.equal(body.p_submission_id, submissionId); assert.equal(body.p_question_id, essayId);
            state.essayScore = body.p_score; data = { id: submissionId, total_score: 2.5 + state.essayScore, status: 'graded' }; break;
          case 'issue_api_token': data = { token: 'exam_test_token_only', expires_at: '2026-11-04T00:00:00Z' }; break;
          case 'revoke_api_tokens': data = { revoked: 1 }; break;
          default: throw new Error(`Unexpected mocked Supabase endpoint: ${url.pathname}`);
        }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
  }
  return { state, install };
}

test('browser: registration, teacher authoring, Pages link, student submission, grading and Actions key', { skip: !tools, timeout: 90000 }, async () => {
  const require = createRequire(resolve(tools, 'package.json'));
  const { chromium } = require('playwright');
  const server = await serve();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.EXAM_BROWSER_EXECUTABLE ? { executablePath: process.env.EXAM_BROWSER_EXECUTABLE } : {}), args: ['--no-sandbox'] });
    const backend = fakeBackend();
    const context = await browser.newContext({ locale: 'fa-IR', viewport: { width: 1280, height: 900 } });
    await backend.install(context);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(site);
    await page.locator('#auth-form').waitFor();
    assert.equal(await page.locator('#logout').isVisible(), false, 'Teacher logout must be hidden on the login screen');
    await screenshot(page, 'exam-login.png');
    await page.locator('#register-tab').click();
    await page.locator('[name=first_name]').fill('آرشیا');
    await page.locator('[name=last_name]').fill('معلم');
    await page.locator('[name=phone]').fill('۰۹۱۲۳۴۵۶۷۸۹');
    await page.locator('[name=username]').fill('Teacher_01');
    await page.locator('[name=password]').fill('only-a-test-password');
    await page.locator('#auth-form button[type=submit]').click();
    await page.locator('#new-exam').waitFor();
    const signup = backend.state.calls.find(c => c.path === '/auth/v1/signup');
    assert.deepEqual(signup.body.data, { username: 'teacher_01', first_name: 'آرشیا', last_name: 'معلم', phone: '09123456789' });
    assert.equal(signup.body.email, 'teacher_01@teachers.exam.invalid');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('exam.teacher.session').includes('only-a-test-password')), false);

    await page.locator('#logout').click();
    await page.locator('#auth-form').waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('exam.teacher.session')), null);
    await page.locator('[name=username]').fill('Teacher_01');
    await page.locator('[name=password]').fill('only-a-test-password');
    await page.locator('#auth-form button[type=submit]').click();
    await page.locator('#new-exam').waitFor();
    assert.ok(backend.state.calls.some(c => c.path === '/auth/v1/token' && c.query === '?grant_type=password'));

    await page.locator('summary').click();
    await page.locator('#issue-token').click();
    await page.locator('#api-token').waitFor();
    assert.equal(await page.locator('#api-token').getAttribute('type'), 'password');
    assert.equal(await page.locator('#api-token').inputValue(), 'exam_test_token_only');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#revoke-token').click();
    await page.waitForFunction(() => document.querySelector('#token-output').textContent === '');
    assert.ok(backend.state.calls.some(c => c.path.endsWith('/revoke_api_tokens')));

    await page.locator('#new-exam').click();
    await page.locator('[name=title]').fill('آزمون علوم');
    const question = page.locator('.question').first();
    await question.locator('.prompt').fill(`حاصل ۲ + ۲؟ ${malicious}`);
    await question.locator('.points').fill('2.5');
    for (const [i, option] of ['یک', 'دو', '<script>window.__xss=1</script>', 'چهار'].entries()) await question.locator('.option-text').nth(i).fill(option);
    await question.locator('input[type=radio]').nth(3).check();
    await page.locator('#add-essay').click();
    const written = page.locator('.question').nth(1);
    await written.locator('.prompt').fill('چرخه آب را توضیح دهید.');
    await written.locator('.points').fill('7.5');
    await screenshot(page, 'exam-creator.png');
    await page.locator('#create-form button[type=submit]').click();
    await page.locator('#exam-link').waitFor();
    const link = await page.locator('#exam-link').inputValue();
    assert.equal(link, `${site}id/${examId}`);
    assert.equal(backend.state.exam.questions[0].correct, 3);
    assert.deepEqual(backend.state.exam.questions.map(q => q.points), [2.5, 7.5]);
    await page.locator('#done').click();
    await page.locator('.results').waitFor();
    await screenshot(page, 'exam-dashboard.png');

    const studentContext = await browser.newContext({ locale: 'fa-IR', viewport: { width: 390, height: 844 } });
    await backend.install(studentContext);
    const fallback = await readFile(resolve(repository, '404.html'), 'utf8');
    await studentContext.route(`${site}id/**`, route => route.fulfill({ status: 404, contentType: 'text/html', body: fallback }));
    const student = await studentContext.newPage();
    student.on('pageerror', e => pageErrors.push(e.message));
    await student.goto(link);
    await student.locator('#student-form').waitFor();
    assert.equal(await student.locator('#logout').isVisible(), false, 'Student view must not expose a teacher logout control');
    assert.equal(student.url(), link, 'Pages fallback must restore the shareable /exam/id/ URL');
    assert.equal(await student.locator('.question img, .question script').count(), 0);
    assert.ok((await student.locator('.question').first().textContent()).includes(malicious));
    assert.equal(await student.evaluate(() => window.__xss), undefined);
    assert.equal(await student.locator('text=گزینه صحیح').count(), 0);
    assert.equal(await student.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Student layout should fit a mobile screen');
    await student.locator('[name=first_name]').fill('دانش‌آموز');
    await student.locator('[name=last_name]').fill(malicious);
    await student.locator(`input[name="q-${mcqId}"][value="3"]`).check();
    await student.locator(`textarea[name="q-${essayId}"]`).fill(`پاسخ علمی ${malicious}`);
    await screenshot(student, 'exam-student-mobile.png');
    await student.locator('#student-form button[type=submit]').click();
    await student.locator('text=آزمون را به پایان رساندید').waitFor();
    assert.equal(backend.state.submission.p_answers[mcqId].choice, 3);
    assert.equal(backend.state.submission.p_answers[essayId].text, `پاسخ علمی ${malicious}`);
    assert.equal(await student.locator('#student-form').count(), 0, 'Receipt must replace the editable submission form');

    await page.locator('.results').click();
    await page.locator('tbody tr').waitFor();
    assert.ok((await page.locator('tbody').textContent()).includes(malicious));
    assert.equal(await page.locator('#app img, #app script').count(), 0);
    assert.equal(await page.locator('details .question').count(), 0, 'Collapsed student answers should be deferred until that student is opened');
    await page.locator('details summary').click();
    await page.locator('.grade-form').waitFor({ state: 'attached' });
    const grading = page.locator('.grade-form');
    await grading.locator('[name=score]').fill('6.5');
    const gradeCallsBefore = backend.state.calls.length;
    await grading.evaluate(form => { window.__gradeForm = form; });
    await grading.locator('button').click();
    await page.locator('tbody').getByText('تصحیح کامل').waitFor();
    assert.equal(backend.state.essayScore, 6.5);
    assert.ok((await page.locator('tbody').textContent()).includes('۹'));
    assert.deepEqual(backend.state.calls.slice(gradeCallsBefore).map(call => call.path), ['/rest/v1/rpc/grade_answer'], 'Grading should update the visible result using its RPC response without fetching every answer again');
    assert.equal(await grading.evaluate(form => form === window.__gradeForm), true, 'Saving a grade must preserve the open form and its position');
    assert.equal(await page.locator('details').getAttribute('open'), '', 'The student answers must stay open after a grade is saved');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    await screenshot(page, 'exam-results.png');

    // Returning through the UI reuses recent owner-scoped data. Explicit refresh
    // must still discover changes made by a student or another teacher session.
    const callsBeforeReturn = backend.state.calls.length;
    await page.locator('#back').click();
    await page.locator('.results').waitFor();
    assert.equal(backend.state.calls.length, callsBeforeReturn, 'Returning to a recent dashboard should avoid another list request');
    await page.locator('#refresh-exams').click();
    await page.waitForFunction(() => document.querySelector('#exam-list')?.textContent.includes('۱ پاسخ'));
    assert.equal(backend.state.calls.at(-1).path, '/rest/v1/rpc/list_exams');
    const callsBeforeResultsReturn = backend.state.calls.length;
    await page.locator('.results').click();
    await page.locator('tbody tr').waitFor();
    assert.equal(backend.state.calls.length, callsBeforeResultsReturn, 'Returning to recent results should reuse the saved grade');
    assert.ok((await page.locator('tbody').textContent()).includes('۹ از ۱۰'));
    backend.state.essayScore = 7;
    await page.locator('#refresh-results').click();
    await page.locator('tbody').getByText('۹٫۵ از ۱۰').waitFor();
    assert.equal(backend.state.calls.at(-1).path, '/rest/v1/rpc/get_results');

    // A second teacher must never see the first teacher's cached titles/results.
    await page.locator('#logout').click();
    await page.locator('#auth-form').waitFor();
    backend.state.authSession = { ...session, access_token: 'second-teacher-access', refresh_token: 'second-teacher-refresh', user: { id: '55555555-5555-4555-8555-555555555555' } };
    backend.state.exam.title = 'آزمون اختصاصی معلم دوم';
    const listsBeforeSecondLogin = backend.state.calls.filter(call => call.path.endsWith('/list_exams')).length;
    await page.locator('[name=username]').fill('Teacher_02');
    await page.locator('[name=password]').fill('second-test-password');
    await page.locator('#auth-form button[type=submit]').click();
    await page.locator('.results').waitFor();
    assert.equal(backend.state.calls.filter(call => call.path.endsWith('/list_exams')).length, listsBeforeSecondLogin + 1, 'Login as another teacher must fetch that teacher’s dashboard');
    assert.ok((await page.locator('#exam-list').textContent()).includes('آزمون اختصاصی معلم دوم'));
    await page.locator('.results').click();
    await page.locator('tbody tr').waitFor();
    assert.equal(backend.state.calls.at(-1).path, '/rest/v1/rpc/get_results', 'The first teacher’s result cache must not be reused after logout');
    assert.ok((await page.locator('#app h1').textContent()).includes('آزمون اختصاصی معلم دوم'));
    await page.locator('#back').click();
    await page.locator('.results').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Teacher dashboard should fit a mobile screen');
    await screenshot(page, 'exam-dashboard-mobile.png');
    assert.deepEqual(pageErrors, []);
    await context.close();
    await studentContext.close();

    // Check the real browser's expired-session recovery without contacting Supabase.
    const refreshContext = await browser.newContext();
    await refreshContext.addInitScript(value => sessionStorage.setItem('exam.teacher.session', JSON.stringify(value)), session);
    const refreshed = { ...session, access_token: 'test-refreshed-access' };
    let lists = 0;
    let refreshes = 0;
    await refreshContext.route('https://*.supabase.co/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      let status = 200;
      let body;
      if (url.pathname.endsWith('/list_exams')) {
        lists++;
        if (lists === 1) { status = 401; body = { message: 'JWT expired' }; }
        else { assert.equal(request.headers().authorization, `Bearer ${refreshed.access_token}`); body = []; }
      } else if (url.pathname === '/auth/v1/token' && url.search === '?grant_type=refresh_token') {
        refreshes++;
        assert.deepEqual(request.postDataJSON(), { refresh_token: session.refresh_token });
        body = refreshed;
      } else throw new Error(`Unexpected endpoint during refresh test: ${url.pathname}`);
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const refreshPage = await refreshContext.newPage();
    await refreshPage.goto(site);
    await refreshPage.locator('#new-exam').waitFor();
    assert.equal(lists, 2);
    assert.equal(refreshes, 1);
    assert.equal(await refreshPage.evaluate(() => JSON.parse(sessionStorage.getItem('exam.teacher.session')).access_token), refreshed.access_token);
    await refreshContext.close();
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  }
});
