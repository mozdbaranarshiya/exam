// Explicit, deterministic browser benchmark; no live Supabase calls.
// EXAM_BROWSER_TOOLS=/workspace/.exam-tools EXAM_BROWSER_EXECUTABLE=/usr/bin/chromium \
// EXAM_BENCHMARK_BASELINE=/tmp/exam-baseline-a0499dd/exam node tests/performance-browser.mjs
// The baseline directory is a read-only copy of the committed static files, not a worktree.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tooling = process.env.EXAM_BROWSER_TOOLS;
if (!tooling) throw new Error('EXAM_BROWSER_TOOLS is required for the optional browser benchmark.');
if (!process.env.EXAM_BENCHMARK_BASELINE) throw new Error('EXAM_BENCHMARK_BASELINE must point to the committed baseline static-file copy.');
const { chromium } = createRequire(resolve(tooling, 'package.json'))('playwright');
const latencyMs = 150;
const studentCount = 50;
const questionCount = 20;
const rounds = 3;
const examId = 453395;
const teacher = { access_token: 'benchmark-only-teacher', refresh_token: 'benchmark-only-refresh', user: { id: '44444444-4444-4444-8444-444444444444' } };
const essayId = '22222222-2222-4222-8222-222222222222';
const submissionId = '33333333-3333-4333-8333-333333333333';
const questions = Array.from({ length: questionCount }, (_, index) => ({
  id: index === questionCount - 1 ? essayId : `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
  type: index === questionCount - 1 ? 'essay' : 'mcq', prompt: `سؤال آزمایشی ${index + 1}`,
  points: index === questionCount - 1 ? 5 : 1,
  ...(index === questionCount - 1 ? {} : { options: ['الف', 'ب', 'ج', 'د'], correct: 0 }),
}));

async function screenshot(page, label, view) {
  if (!process.env.EXAM_BENCHMARK_SCREENSHOTS) return;
  await mkdir(process.env.EXAM_BENCHMARK_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: resolve(process.env.EXAM_BENCHMARK_SCREENSHOTS, `performance-${label}-${view}.png`) });
}

async function serve(directory) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const relative = pathname === '/exam/' ? 'index.html' : pathname.replace(/^\/exam\//, '');
    const file = resolve(directory, relative);
    if (!file.startsWith(`${resolve(directory)}/`)) { response.writeHead(404); response.end(); return; }
    try { response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); response.end(await readFile(file)); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  return { server, site: `http://127.0.0.1:${server.address().port}/exam/` };
}

async function exercise(browser, directory, label) {
  const { server, site } = await serve(directory);
  const context = await browser.newContext({ locale: 'fa-IR', viewport: { width: 1280, height: 900 } });
  await context.addInitScript(value => sessionStorage.setItem('exam.teacher.session', JSON.stringify(value)), teacher);
  let essayScore = null;
  const calls = [];
  const result = () => ({
    id: examId, title: 'آزمون سنجش سرعت', questions,
    submissions: Array.from({ length: studentCount }, (_, index) => ({
      id: index === 0 ? submissionId : `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
      first_name: `دانش‌آموز ${index + 1}`, last_name: 'آزمایشی', max_score: 24,
      total_score: 19 + (index === 0 ? essayScore ?? 0 : 0),
      status: index === 0 && essayScore !== null ? 'graded' : 'pending', created_at: '2026-10-05T00:00:00Z',
      answers: questions.map(question => ({
        question_id: question.id, type: question.type, prompt: question.prompt, points: question.points,
        ...(question.type === 'mcq' ? { choice: 0, correct: 0, score: 1 } : { text: 'پاسخ تشریحی دانش‌آموز برای سنجش عملکرد', score: index === 0 ? essayScore : null }),
      })),
    })),
  });
  await context.route('https://*.supabase.co/**', async route => {
    const request = route.request();
    const operation = new URL(request.url()).pathname.split('/').at(-1);
    calls.push(operation);
    assert.equal(request.headers().authorization, `Bearer ${teacher.access_token}`);
    let response;
    if (operation === 'list_exams') response = [{ id: examId, title: 'آزمون سنجش سرعت', total_points: 24, question_count: questionCount, submission_count: studentCount, created_at: '2026-10-05T00:00:00Z' }];
    else if (operation === 'get_results') response = result();
    else if (operation === 'grade_answer') {
      assert.equal(request.postDataJSON().p_submission_id, submissionId);
      assert.equal(request.postDataJSON().p_question_id, essayId);
      essayScore = request.postDataJSON().p_score;
      response = { id: submissionId, total_score: 19 + essayScore, status: 'graded' };
    } else throw new Error(`Unexpected benchmark request: ${operation}`);
    await new Promise(resolveDelay => setTimeout(resolveDelay, latencyMs));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(site);
    await page.locator('.results').waitFor();
    await screenshot(page, label, 'dashboard');
    await page.locator('.results').click();
    await page.locator('tbody tr').first().waitFor();
    assert.equal(await page.locator('tbody tr').count(), studentCount);
    const collapsedAnswerSections = await page.locator('details .question').count();
    await screenshot(page, label, 'results');
    await page.locator('details summary').first().click();
    const form = page.locator('.grade-form').first();
    await form.locator('[name=score]').fill('2.5');
    const beforeGrade = calls.length;
    const gradeStart = performance.now();
    await form.locator('button').click();
    await page.locator('tbody tr').first().getByText('تصحیح کامل').waitFor();
    const gradeMs = performance.now() - gradeStart;
    const gradeRequests = calls.slice(beforeGrade);
    assert.ok((await page.locator('tbody tr').first().textContent()).includes('۲۱٫۵'));
    const beforeDashboard = calls.length;
    const dashboardStart = performance.now();
    await page.locator('#back').click();
    await page.locator('.results').waitFor();
    const dashboardReturnMs = performance.now() - dashboardStart;
    const dashboardReturnRequests = calls.slice(beforeDashboard);
    const beforeResults = calls.length;
    const resultsStart = performance.now();
    await page.locator('.results').click();
    await page.locator('tbody tr').first().waitFor();
    const resultsReturnMs = performance.now() - resultsStart;
    const resultsReturnRequests = calls.slice(beforeResults);
    assert.ok((await page.locator('tbody tr').first().textContent()).includes('۲۱٫۵'), 'The cached result must retain the newly saved grade');
    assert.deepEqual(errors, []);
    if (label === 'current') {
      assert.deepEqual(gradeRequests, ['grade_answer']);
      assert.deepEqual(dashboardReturnRequests, []);
      assert.deepEqual(resultsReturnRequests, []);
      assert.equal(collapsedAnswerSections, 0);
    }
    return { gradeMs, dashboardReturnMs, resultsReturnMs, gradeRequests, dashboardReturnRequests, resultsReturnRequests, collapsedAnswerSections, totalRpcRequests: calls.length };
  } finally {
    await context.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

const browser = await chromium.launch({ headless: true, ...(process.env.EXAM_BROWSER_EXECUTABLE ? { executablePath: process.env.EXAM_BROWSER_EXECUTABLE } : {}), args: ['--no-sandbox'] });
try {
  const samples = { baseline: [], current: [] };
  for (let round = 0; round < rounds; round++) {
    samples.baseline.push(await exercise(browser, resolve(process.env.EXAM_BENCHMARK_BASELINE), 'baseline'));
    samples.current.push(await exercise(browser, repository, 'current'));
  }
  const median = values => Math.round([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]);
  const summarize = values => ({
    medianMs: Object.fromEntries(['gradeMs', 'dashboardReturnMs', 'resultsReturnMs'].map(metric => [metric, median(values.map(sample => sample[metric]))])),
    gradeRequests: values[0].gradeRequests, dashboardReturnRequests: values[0].dashboardReturnRequests,
    resultsReturnRequests: values[0].resultsReturnRequests, collapsedAnswerSections: values[0].collapsedAnswerSections,
    totalRpcRequests: values[0].totalRpcRequests,
  });
  console.log(JSON.stringify({ result: 'PASS', kind: 'local controlled browser comparison; not production response times', latencyMs, studentCount, questionCount, rounds, baseline: summarize(samples.baseline), current: summarize(samples.current), samples }, null, 2));
} finally { await browser.close(); }
