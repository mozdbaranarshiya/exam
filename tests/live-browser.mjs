// Explicit opt-in real-backend browser smoke test. Never run as part of npm test.
// EXAM_BROWSER_TOOLS=/workspace/.exam-tools EXAM_BROWSER_EXECUTABLE=/usr/bin/chromium node tests/live-browser.mjs
// Requires the project's injected SUPABASE_ACCESS_TOKEN solely to clean up this test's own account.
// If Chromium cannot trust the supplied proxy CA, EXAM_BROWSER_HTTPS_BRIDGE=1 forwards
// actual backend traffic through Python's verified HTTPS client. This does not test
// Chromium's TLS or preflight transport; it does test the UI against the real backend.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = 'pukanizbahswrupscfmg';
if (!process.env.SUPABASE_ACCESS_TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN is required for exact-account cleanup.');
const tools = process.env.EXAM_BROWSER_TOOLS;
if (!tools) throw new Error('EXAM_BROWSER_TOOLS must point to isolated Playwright tooling.');
const { chromium } = createRequire(resolve(tools, 'package.json'))('playwright');
const username = `onb_browser_${randomBytes(8).toString('hex')}`;
const email = `${username}@teachers.exam.invalid`;
const password = randomBytes(24).toString('base64url');
const statuses = [];
const failures = [];
const browserErrors = [];
let teacherId;
let examId;
let browser;
let stage = 'initialization';

async function managementQuery(query) {
  // Credentials remain in the injected environment and never become command arguments.
  const source = `import json,os,sys,urllib.request,urllib.error
req=urllib.request.Request('https://api.supabase.com/v1/projects/${project}/database/query',data=json.dumps({'query':sys.argv[1]}).encode(),headers={'Authorization':'Bearer '+os.environ['SUPABASE_ACCESS_TOKEN'],'Content-Type':'application/json'},method='POST')
try:
 with urllib.request.urlopen(req,timeout=45) as r: print(r.read().decode())
except urllib.error.HTTPError as e: raise SystemExit('Management SQL request failed: HTTP '+str(e.code))
except Exception as e: raise SystemExit('Management SQL request failed: '+type(e).__name__)`;
  const { stdout } = await promisify(execFile)('python3', ['-c', source, query], { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

async function verifiedForward(request) {
  const source = `import json,sys,urllib.request,urllib.error,urllib.parse
data=json.load(sys.stdin)
if urllib.parse.urlparse(data['url']).netloc != '${project}.supabase.co': raise SystemExit('Unexpected backend host')
body=data['body'].encode() if data['body'] is not None else None
headers={k:v for k,v in data['headers'].items() if k.lower() not in ('host','content-length')}
req=urllib.request.Request(data['url'],data=body,headers=headers,method=data['method'])
try: r=urllib.request.urlopen(req,timeout=40)
except urllib.error.HTTPError as e: r=e
except Exception as e: raise SystemExit('Verified HTTPS forwarding failed: '+type(e).__name__)
with r:
 headers={k:v for k,v in r.headers.items() if k.lower() not in ('content-length','content-encoding','transfer-encoding','connection')}
 print(json.dumps({'status':r.status,'headers':headers,'body':r.read().decode('utf-8')}))`;
  // Auth headers and response tokens remain in memory, passed via pipes, never argv/files/logs.
  return new Promise((resolveForward, rejectForward) => {
    const child = spawn('python3', ['-c', source], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.resume();
    child.on('error', () => rejectForward(new Error('Verified HTTPS helper could not start.')));
    child.on('close', code => {
      if (code !== 0) { rejectForward(new Error('Verified HTTPS helper request failed.')); return; }
      try { resolveForward(JSON.parse(stdout)); } catch { rejectForward(new Error('Verified HTTPS helper returned invalid data.')); }
    });
    child.stdin.end(JSON.stringify({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() }));
  });
}

const publicFiles = new Set(['index.html', '404.html', 'app.js', 'core.js', 'config.js', 'style.css']);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  let file = pathname === '/exam/' || pathname === '/exam' ? 'index.html' : pathname.replace(/^\/exam\//, '');
  let status = 200;
  if (/^\/exam\/id\/\d+\/?$/.test(pathname)) { file = '404.html'; status = 404; }
  if (!publicFiles.has(file)) { response.writeHead(404); response.end(); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  try { response.writeHead(status, { 'Content-Type': types[extname(file)] }); response.end(await readFile(resolve(repository, file))); }
  catch { response.writeHead(500); response.end(); }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const site = `http://127.0.0.1:${server.address().port}/exam/`;

async function watch(context) {
  if (process.env.EXAM_BROWSER_HTTPS_BRIDGE === '1') {
    await context.route(`https://${project}.supabase.co/**`, async route => {
      try { await route.fulfill(await verifiedForward(route.request())); }
      catch { await route.abort('failed'); }
    });
  }
  context.on('response', async response => {
    const url = new URL(response.url());
    if (!url.hostname.endsWith('.supabase.co')) return;
    statuses.push({ method: response.request().method(), path: url.pathname + url.search, status: response.status() });
    if (url.pathname === '/auth/v1/signup' && response.ok()) {
      const result = await response.json();
      if (result.user?.email === email) teacherId = result.user.id;
    }
  });
  context.on('requestfailed', request => {
    const url = new URL(request.url());
    failures.push({ host: url.hostname, path: url.pathname, error: request.failure()?.errorText });
  });
  context.on('page', page => page.on('pageerror', error => browserErrors.push(error.message)));
}

try {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const proxy = proxyUrl ? new URL(proxyUrl) : null;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.EXAM_BROWSER_EXECUTABLE ? { executablePath: process.env.EXAM_BROWSER_EXECUTABLE } : {}),
    ...(proxy ? { proxy: {
      server: `${proxy.protocol}//${proxy.hostname}:${proxy.port || (proxy.protocol === 'https:' ? '443' : '80')}`,
      bypass: '127.0.0.1,localhost',
      ...(proxy.username ? { username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) } : {}),
    } } : {}),
    args: ['--no-sandbox'],
  });
  const teacher = await browser.newContext({ locale: 'fa-IR', viewport: { width: 1280, height: 900 } });
  teacher.setDefaultTimeout(25000);
  await watch(teacher);
  const page = await teacher.newPage();
  await page.goto(site);
  stage = 'teacher registration';
  await page.locator('#register-tab').click();
  await page.locator('[name=first_name]').fill('آزمایشی');
  await page.locator('[name=last_name]').fill('مرورگر');
  await page.locator('[name=phone]').fill('09120000000');
  await page.locator('[name=username]').fill(username);
  await page.locator('[name=password]').fill(password);
  await page.locator('#auth-form button[type=submit]').click();
  await page.locator('#new-exam').waitFor();
  const registered = await page.evaluate(() => JSON.parse(sessionStorage.getItem('exam.teacher.session'))?.user);
  assert.equal(registered.email, email);
  teacherId = registered.id;
  assert.equal(await page.evaluate(value => sessionStorage.getItem('exam.teacher.session').includes(value), password), false);

  stage = 'logout and username login';
  await page.locator('#logout').click();
  await page.locator('#auth-form').waitFor();
  await page.locator('[name=username]').fill(username);
  await page.locator('[name=password]').fill(password);
  await page.locator('#auth-form button[type=submit]').click();
  await page.locator('#new-exam').waitFor();
  stage = 'mixed exam authoring';
  await page.locator('#new-exam').click();
  await page.locator('[name=title]').fill('آزمون خودکار مرورگر — موقت');
  const mcq = page.locator('.question').first();
  await mcq.locator('.prompt').fill('حاصل ۲ + ۲ چیست؟');
  await mcq.locator('.points').fill('2');
  for (const [index, option] of ['یک', 'دو', 'سه', 'چهار'].entries()) await mcq.locator('.option-text').nth(index).fill(option);
  await mcq.locator('input[type=radio]').nth(3).check();
  await page.locator('#add-essay').click();
  const essay = page.locator('.question').nth(1);
  await essay.locator('.prompt').fill('یک پاسخ تشریحی آزمایشی بنویسید.');
  await essay.locator('.points').fill('3');
  await page.locator('#create-form button[type=submit]').click();
  await page.locator('#exam-link').waitFor();
  const link = await page.locator('#exam-link').inputValue();
  examId = link.match(/\/id\/(\d{12})$/)?.[1];
  assert.ok(examId, 'Generated exam must have a twelve-digit ID.');
  assert.equal(link, `${site}id/${examId}`);
  await page.locator('#done').click();
  await page.locator('.results').waitFor();

  const student = await browser.newContext({ locale: 'fa-IR', viewport: { width: 390, height: 844 } });
  student.setDefaultTimeout(25000);
  await watch(student);
  const studentPage = await student.newPage();
  stage = 'anonymous student route and submission';
  await studentPage.goto(link);
  await studentPage.locator('#student-form').waitFor();
  assert.equal(studentPage.url(), link, 'Pages fallback must restore student URL.');
  assert.equal(await studentPage.locator('#logout').isVisible(), false);
  assert.equal(await studentPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await studentPage.locator('[name=first_name]').fill('دانش‌آموز آزمایشی');
  await studentPage.locator('[name=last_name]').fill('مرورگر');
  await studentPage.locator('.question').first().locator('input[type=radio]').nth(3).check();
  await studentPage.locator('.question').nth(1).locator('textarea').fill('این پاسخ فقط برای آزمون خودکار موقت است.');
  await studentPage.locator('#student-form button[type=submit]').click();
  await studentPage.getByText('آزمون را به پایان رساندید').waitFor();
  stage = 'teacher grades and essay scoring';
  await page.locator('.results').click();
  await page.locator('.grade-form').waitFor({ state: 'attached' });
  assert.ok((await page.locator('tbody').textContent()).includes('در انتظار تصحیح تشریحی'));
  assert.ok((await page.locator('tbody').textContent()).includes('۲ از ۵'));
  await page.locator('details summary').click();
  await page.locator('.grade-form [name=score]').fill('2.5');
  await page.locator('.grade-form button').click();
  await page.locator('tbody').getByText('تصحیح کامل').waitFor();
  assert.ok((await page.locator('tbody').textContent()).includes('۴٫۵ از ۵'));
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ result: 'PASS', transport: process.env.EXAM_BROWSER_HTTPS_BRIDGE === '1' ? 'verified HTTPS bridge to real backend; browser TLS/preflight not exercised' : 'Chromium HTTPS', checks: ['signup', 'logout', 'username login', 'mixed exam creation', 'student Pages fallback', 'mobile layout', 'anonymous submission', 'initial MCQ score', 'essay grading', 'final score 4.5/5'], requests: statuses }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', stage, error: error.name, requests: statuses, networkFailures: failures, browserErrorCount: browserErrors.length }, null, 2));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
  if (teacherId && /^[0-9a-f-]{36}$/i.test(teacherId)) {
    await managementQuery(`delete from auth.users where id = '${teacherId}'::uuid and email = '${email}';`);
    const cleanup = await managementQuery(`select (select count(*)::int from auth.users where id = '${teacherId}'::uuid and email = '${email}') as auth_count, (select count(*)::int from public.teacher_profiles where id = '${teacherId}'::uuid) as profile_count, (select count(*)::int from public.exams where owner_id = '${teacherId}'::uuid) as exam_count;`);
    assert.equal(cleanup[0]?.auth_count, 0);
    assert.equal(cleanup[0]?.profile_count, 0);
    assert.equal(cleanup[0]?.exam_count, 0);
    console.log('CLEANUP VERIFIED: exact temporary Auth user, profile and exams removed.');
  } else console.log('No temporary Auth account was confirmed created; no cleanup deletion attempted.');
}
