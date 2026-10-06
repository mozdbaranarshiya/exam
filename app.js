import { normalizeUsername, normalizeDigits, validateQuestions, examLink } from './core.js';
import { createReadCache } from './read-cache.js';

const app = document.querySelector('#app');
const config = window.EXAM_CONFIG || {};
const base = new URL('.', import.meta.url).pathname;
document.querySelector('.brand').href = base;
const SESSION_KEY = 'exam.teacher.session';
const reads = createReadCache();
let viewSequence = 0;
let refreshingSession;
let session;
try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { sessionStorage.removeItem(SESSION_KEY); }
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = v => Number(v || 0).toLocaleString('fa-IR');
const date = v => new Date(v).toLocaleString('fa-IR');
let noticeTimer;
function startView(name) {
  document.body.dataset.view = name;
  const sequence = ++viewSequence;
  return () => sequence === viewSequence;
}
const loading = text => `<div class="loading-state" role="status"><span class="loading-ring" aria-hidden="true"></span><p>${text}</p></div>`;
function notice(message) {
  const element = document.querySelector('#notice'); element.textContent = message; element.style.display = 'block';
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { element.style.display = 'none'; }, 8000);
}
function saveSession(value) {
  if (!value || session?.user?.id !== value.user?.id) reads.clear();
  session = value;
  if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); else sessionStorage.removeItem(SESSION_KEY);
  document.querySelector('#logout').hidden = !value;
}
function errorMessage(data) {
  if (data.code === 'PGRST202') return 'ساختار پایگاه داده هنوز نصب نشده است. فایل مهاجرت Supabase را اجرا کنید.';
  if (['invalid_credentials','invalid_grant'].includes(data.error_code)) return 'نام کاربری یا رمز عبور درست نیست.';
  if (data.error_code === 'email_not_confirmed') return 'ورود فعال نشده است. مدیر پروژه باید تنظیم تأیید ایمیل را مطابق راهنما انجام دهد.';
  if (data.error_code === 'user_already_exists') return 'این نام کاربری قبلاً ثبت شده است.';
  if (data.code === '42501') return 'اجازه دسترسی به این آزمون را ندارید.';
  if (data.code === '22023') return 'اطلاعات واردشده معتبر نیست. متن، گزینه‌ها و بارم‌ها را بررسی کنید.';
  if (data.code === 'P0002') return 'آزمون پیدا نشد.';
  return 'درخواست انجام نشد. تنظیمات Supabase و اطلاعات واردشده را بررسی کنید.';
}
async function request(path, body, authenticated = false, method = 'POST', retry = true) {
  const requestSession = session;
  const headers = {apikey:config.supabaseKey,'Content-Type':'application/json'};
  if (authenticated) {
    if (!session?.access_token) throw new Error('برای ادامه وارد حساب معلم شوید.');
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  let response;
  try { response = await fetch(config.supabaseUrl + path, {method,headers,...(method === 'GET' ? {} : {body:JSON.stringify(body || {})})}); }
  catch { throw new Error('اتصال برقرار نشد. اینترنت و دسترسی شبکه به Supabase را بررسی کنید.'); }
  const data = await response.json().catch(() => ({}));
  if (authenticated && session?.user?.id !== requestSession?.user?.id) throw new Error('حساب کاربری تغییر کرده است؛ درخواست را دوباره انجام دهید.');
  if (response.status === 401 && authenticated && retry && session?.refresh_token) {
    if (session.access_token === requestSession.access_token) {
      try {
        refreshingSession ||= request('/auth/v1/token?grant_type=refresh_token',{refresh_token:session.refresh_token}).then(value => {
          if (session === requestSession) saveSession(value);
        }).finally(() => { refreshingSession = null; });
        await refreshingSession;
      } catch {
        if (session === requestSession) { saveSession(null); authView(); }
        throw new Error('نشست شما منقضی شده است؛ دوباره وارد شوید.');
      }
    }
    return request(path,body,true,method,false);
  }
  if (!response.ok) throw new Error(errorMessage(data));
  return data;
}
const rpc = (name, body = {}, authenticated = true) => request(`/rest/v1/rpc/${name}`,body,authenticated);
async function busy(form, task) {
  const buttons = [...form.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
  try { await task(); } catch (e) { notice(e.message); }
  finally { buttons.forEach(b => b.disabled = false); }
}
document.querySelector('#logout').onclick = async () => {
  const logoutRequest = session ? request('/auth/v1/logout',{},true).catch(() => {}) : Promise.resolve();
  saveSession(null); authView();
  await logoutRequest;
};
const dashboardLink = document.querySelector('#dashboard-link');
if (dashboardLink) {
  dashboardLink.href = base;
  dashboardLink.onclick = e => { if (session) { e.preventDefault(); history.replaceState(null,'',base); dashboard(); } };
}

function authView(register = false) {
  const active = startView('auth');
  document.querySelector('#logout').hidden = true;
  app.innerHTML = `<section class="hero"><div><div class="eyebrow">کلاس شما، آزمون شما</div><h1>آزمون بسازید.<br>یادگیری را ببینید.</h1><p>سؤال‌های تستی و تشریحی را کنار هم بچینید، بارم بدهید و تنها با یک لینک، آزمون را به کلاس برسانید.</p><div class="card accent"><h3>یک مسیر ساده برای هر آزمون</h3><p>۱. طراحی سؤال و انتخاب پاسخ صحیح<br>۲. ارسال لینک اختصاصی برای دانش‌آموزان<br>۳. مشاهده نمرات و تصحیح پاسخ‌های تشریحی</p><span class="badge">تستی با تصحیح خودکار</span> <span class="badge">تشریحی با تصحیح معلم</span></div></div><div class="card"><div class="tabs"><button id="login-tab" class="${register ? 'secondary' : ''}">ورود معلم</button><button id="register-tab" class="${register ? '' : 'secondary'}">ثبت‌نام</button></div><h2>${register ? 'حساب معلم بسازید' : 'به کلاس خود برگردید'}</h2><form id="auth-form">${register ? '<div class="grid"><label>نام<input name="first_name" required maxlength="80" autocomplete="given-name"></label><label>نام خانوادگی<input name="last_name" required maxlength="80" autocomplete="family-name"></label></div><label>شماره موبایل<input name="phone" required type="tel" dir="ltr" maxlength="16" autocomplete="tel" placeholder="09123456789"></label>' : ''}<label>نام کاربری<input name="username" required dir="ltr" minlength="3" maxlength="32" autocomplete="username" placeholder="teacher_01"></label><p class="muted">۳ تا ۳۲ حرف انگلیسی، عدد یا زیرخط</p><label>رمز عبور<input name="password" required type="password" minlength="8" maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}"></label><button type="submit">${register ? 'ساخت حساب' : 'ورود به سامانه'}</button></form><footer>ورود دانش‌آموز از طریق لینک آزمون است و به حساب کاربری نیاز ندارد.</footer></div></section>`;
  document.querySelector('#login-tab').onclick = () => authView();
  document.querySelector('#register-tab').onclick = () => authView(true);
  const form = document.querySelector('#auth-form');
  form.onsubmit = e => { e.preventDefault(); busy(form, async () => {
    const f = new FormData(form); const username = normalizeUsername(f.get('username'));
    const credentials = {email:`${username}@teachers.exam.invalid`,password:f.get('password')};
    let value;
    if (register) {
      const phone = normalizeDigits(f.get('phone').trim());
      if (!/^\+?[0-9]{7,15}$/.test(phone)) throw new Error('شماره موبایل معتبر وارد کنید.');
      const result = await request('/auth/v1/signup',{...credentials,data:{username,first_name:f.get('first_name').trim(),last_name:f.get('last_name').trim(),phone}});
      if (!result.access_token) { authView(); notice('حساب ایجاد شد؛ فعال‌سازی ورود نیازمند تنظیم تأیید ایمیل توسط مدیر پروژه است.'); return; }
      value = result;
    } else value = await request('/auth/v1/token?grant_type=password',credentials);
    if (!active()) return;
    saveSession(value);
    await dashboard();
  }); };
}

async function dashboard(force = false) {
  const active = startView('dashboard');
  document.querySelector('#logout').hidden = !session;
  app.innerHTML = loading('در حال دریافت آزمون‌ها…');
  try {
    const exams = await reads.get('exams', () => rpc('list_exams'), force === true);
    if (!active()) return;
    app.innerHTML = `<div class="topline page-heading"><div><div class="eyebrow">فضای کار معلم</div><h1>آزمون‌های من</h1><p>از طراحی سؤال تا دیدن پیشرفت کلاس، همه‌چیز اینجاست.</p></div><div class="row"><button id="refresh-exams" class="secondary">به‌روزرسانی</button><button id="new-exam">+ ساخت آزمون</button></div></div><div class="stats-grid"><div class="stat-card"><span class="stat-label">آزمون‌های شما</span><strong class="stat-value">${fmt(exams.length)}</strong><span class="stat-caption">آماده برای یادگیری</span></div><div class="stat-card"><span class="stat-label">پاسخ‌های دریافت‌شده</span><strong class="stat-value">${fmt(exams.reduce((sum,ex) => sum + Number(ex.submission_count),0))}</strong><span class="stat-caption">از دانش‌آموزان کلاس</span></div><div class="stat-card"><span class="stat-label">سؤال‌های طراحی‌شده</span><strong class="stat-value">${fmt(exams.reduce((sum,ex) => sum + Number(ex.question_count),0))}</strong><span class="stat-caption">تستی و تشریحی</span></div></div><div id="exam-list" class="exam-grid">${exams.length ? exams.map(ex => `<article class="card exam-card"><div class="topline"><h2>${esc(ex.title)}</h2><span class="badge">${fmt(ex.submission_count)} پاسخ</span></div><p>${fmt(ex.question_count)} سؤال · ${fmt(ex.total_points)} نمره · ${esc(date(ex.created_at))}</p><p class="link">${esc(examLink(location.origin,base,ex.id))}</p><div class="row"><button class="results" data-id="${esc(ex.id)}">مشاهده نمرات</button><button class="copy secondary" data-id="${esc(ex.id)}">کپی لینک آزمون</button></div></article>`).join('') : '<div class="card empty"><span class="empty-symbol" aria-hidden="true">✎</span><h2>اولین آزمون شما از اینجا شروع می‌شود</h2><p>سؤال اضافه کنید و لینک را برای دانش‌آموزان بفرستید.</p></div>'}</div><details class="card integration-card"><summary>اتصال به ChatGPT</summary><p>با کلید اختصاصی جدید حساب خود، از ChatGPT بخواهید آزمون بسازد، نمرات را بخواند یا نمره پاسخ تشریحی را ثبت و تغییر دهد. برای افزونه Codex کلید را در متغیر امن EXAM_TEACHER_TOKEN و برای GPT Actions در تنظیمات API Key قرار دهید. کلید را در گفت‌وگو یا با دیگران به اشتراک نگذارید.</p><div class="row"><button id="issue-token">ساخت کلید جدید</button><button id="revoke-token" class="danger">لغو همه کلیدها</button></div><div id="token-output"></div><p class="muted">راهنماهای اتصال در پوشه‌های plugin و actions مخزن قرار دارند. برای دریافت پاسخ‌های تازه، به‌روزرسانی را بزنید.</p></details>`;
    document.querySelector('#new-exam').onclick = creator;
    document.querySelector('#refresh-exams').onclick = () => dashboard(true);
    document.querySelectorAll('.results').forEach(b => b.onclick = () => results(b.dataset.id));
    document.querySelectorAll('.copy').forEach(b => b.onclick = () => copy(examLink(location.origin,base,b.dataset.id)));
    document.querySelector('#issue-token').onclick = async e => {
      await busy(e.target.parentElement, async () => {
        const result = await rpc('issue_api_token');
        if (!active()) return;
        document.querySelector('#token-output').innerHTML = `<label>کلید (فقط همین‌بار نمایش داده می‌شود)<input id="api-token" type="password" readonly dir="ltr" value="${esc(result.token)}"></label><button id="copy-token" class="secondary">کپی کلید</button><p class="muted">مجوز این کلید: ساخت آزمون، خواندن نمرات و ثبت یا تغییر نمره تشریحی.</p><p class="muted">انقضا: ${esc(date(result.expires_at))}</p>`;
        document.querySelector('#copy-token').onclick = () => copy(result.token);
      });
    };
    document.querySelector('#revoke-token').onclick = async e => {
      if (!confirm('تمام کلیدهای ChatGPT این حساب لغو شوند؟')) return;
      await busy(e.target.parentElement,async () => { await rpc('revoke_api_tokens'); if (active()) document.querySelector('#token-output').textContent = ''; notice('کلیدهای قبلی لغو شدند.'); });
    };
  } catch (e) {
    if (!active()) return;
    app.innerHTML = `<div class="card"><h2>دریافت آزمون‌ها انجام نشد</h2><p class="error">${esc(e.message)}</p><button id="retry">تلاش مجدد</button></div>`;
    document.querySelector('#retry').onclick = () => session ? dashboard(true) : authView();
  }
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); notice('کپی شد.'); }
  catch { notice('کپی خودکار در این مرورگر در دسترس نیست؛ متن را انتخاب و کپی کنید.'); }
}

function creator() {
  const active = startView('creator');
  app.innerHTML = `<div class="topline"><div><div class="eyebrow">طراحی آزمون</div><h1>برای یادگیری، سؤال بسازید</h1></div><button id="back" class="secondary">بازگشت</button></div><form id="create-form"><div class="card"><label>عنوان آزمون<input name="title" required maxlength="200" placeholder="مثلاً: آزمون فصل سوم علوم"></label></div><div id="questions"></div><div class="row"><button type="button" id="add-mcq" class="secondary">+ سؤال تستی</button><button type="button" id="add-essay" class="secondary">+ سؤال تشریحی</button><button type="submit">ساخت آزمون و دریافت لینک</button></div><p class="muted">پاسخ صحیح تستی را تیک بزنید. بارم هر سؤال تا ۱۰۰، مجموع آزمون تا ۱۰۰۰ و تعداد سؤال‌ها تا ۱۰۰ است.</p></form>`;
  let counter = 0;
  const add = type => {
    if (document.querySelectorAll('.question').length >= 100) { notice('حداکثر ۱۰۰ سؤال مجاز است.'); return; }
    const uid = ++counter;
    const card = document.createElement('section'); card.className = 'card question'; card.dataset.type = type;
    card.innerHTML = `<div class="topline"><h3>${type === 'mcq' ? 'سؤال تستی' : 'سؤال تشریحی'}</h3><button type="button" class="remove danger">حذف سؤال</button></div><label>متن سؤال<textarea class="prompt" required maxlength="5000"></textarea></label><label>بارم<input class="points" type="number" min="0.01" max="100" step="0.01" required value="1"></label>${type === 'mcq' ? `<p class="muted">تیک کنار گزینه صحیح را انتخاب کنید.</p>${[0,1,2,3].map(i => `<div class="option"><input type="radio" name="correct-${uid}" value="${i}" required aria-label="گزینه ${i+1} پاسخ صحیح است"><input class="option-text" type="text" required maxlength="1000" placeholder="گزینه ${i+1}" aria-label="متن گزینه ${i+1}"></div>`).join('')}` : '<p class="muted">پاسخ این سؤال را پس از دریافت پاسخ‌های دانش‌آموزان تصحیح می‌کنید.</p>'}`;
    card.querySelector('.remove').onclick = () => card.remove(); document.querySelector('#questions').append(card);
  };
  document.querySelector('#back').onclick = () => { if (confirm('از طراحی آزمون خارج شوید؟ سؤال‌های ذخیره‌نشده از دست می‌روند.')) dashboard(); };
  document.querySelector('#add-mcq').onclick = () => add('mcq');
  document.querySelector('#add-essay').onclick = () => add('essay'); add('mcq');
  const form = document.querySelector('#create-form');
  form.onsubmit = e => { e.preventDefault(); busy(form,async () => {
    const questions = validateQuestions([...document.querySelectorAll('.question')].map(card => ({type:card.dataset.type,prompt:card.querySelector('.prompt').value,points:card.querySelector('.points').value,...(card.dataset.type === 'mcq' ? {options:[...card.querySelectorAll('.option-text')].map(i => i.value),correct:Number(card.querySelector('input[type=radio]:checked')?.value ?? -1)} : {})})));
    if (questions.reduce((sum,q) => sum + q.points,0) > 1000) throw new Error('مجموع بارم آزمون نباید بیشتر از ۱۰۰۰ باشد.');
    const result = await rpc('create_exam',{p_title:new FormData(form).get('title').trim(),p_questions:questions});
    reads.invalidate('exams');
    if (!active()) return;
    startView('success');
    const link = examLink(location.origin,base,result.id);
    app.innerHTML = `<div class="card"><span class="badge">آزمون ساخته شد</span><h1>${esc(result.title)}</h1><p>این لینک را برای دانش‌آموزان بفرستید. پاسخ صحیح فقط برای معلم قابل دسترسی است.</p><label>لینک آزمون<input readonly dir="ltr" id="exam-link" value="${esc(link)}"></label><div class="row"><button id="copy-link">کپی لینک</button><button id="done" class="secondary">آزمون‌های من</button></div></div>`;
    document.querySelector('#copy-link').onclick = () => copy(link); document.querySelector('#done').onclick = dashboard;
  }); };
}

async function results(id, force = false) {
  const active = startView('results');
  app.innerHTML = loading('در حال دریافت نمرات…');
  try {
    const data = await reads.get(`results:${id}`, () => rpc('get_results',{p_exam_id:Number(id)}), force === true);
    if (!active()) return;
    const status = s => s.status === 'graded' ? 'تصحیح کامل' : 'در انتظار تصحیح تشریحی';
    const score = s => `${fmt(s.total_score)} از ${fmt(s.max_score)}`;
    app.innerHTML = `<div class="topline page-heading"><div><div class="eyebrow">کارنامه کلاس</div><h1>${esc(data.title)}</h1><p>${fmt(data.submissions.length)} پاسخ دریافت شده؛ پاسخ هر دانش‌آموز را برای تصحیح باز کنید.</p></div><div class="row"><button id="refresh-results" class="secondary">به‌روزرسانی</button><button id="back" class="secondary">آزمون‌های من</button></div></div><div class="card scroll"><table class="results-table"><thead><tr><th>دانش‌آموز</th><th>نمره فعلی</th><th>وضعیت</th><th>ثبت پاسخ</th></tr></thead><tbody>${data.submissions.map(s => `<tr data-student-row="${esc(s.id)}"><td>${esc(s.first_name)} ${esc(s.last_name)}</td><td class="student-score">${score(s)}</td><td class="student-status">${status(s)}</td><td>${esc(date(s.created_at))}</td></tr>`).join('')}</tbody></table>${data.submissions.length ? '' : '<p class="empty">هنوز پاسخی ثبت نشده است.</p>'}</div>${data.submissions.map(s => `<details class="card submission-detail" data-id="${esc(s.id)}"><summary>پاسخ‌های ${esc(s.first_name)} ${esc(s.last_name)} <span class="badge summary-score">${score(s)}</span></summary><div class="answer-content"></div></details>`).join('')}`;
    document.querySelector('#back').onclick = () => dashboard();
    document.querySelector('#refresh-results').onclick = () => results(id,true);
    document.querySelectorAll('.submission-detail').forEach(detail => {
      const submission = data.submissions.find(s => s.id === detail.dataset.id);
      detail.addEventListener('toggle', () => {
        if (!detail.open || detail.dataset.rendered) return;
        detail.dataset.rendered = 'true';
        detail.querySelector('.answer-content').innerHTML = submission.answers.map(a => `<section class="card question"><h3>${esc(a.prompt)}</h3><p>بارم: ${fmt(a.points)}</p>${a.type === 'mcq' ? `<p>گزینه انتخاب‌شده: ${a.choice == null ? 'بدون پاسخ' : fmt(Number(a.choice)+1)} · گزینه صحیح: ${fmt(Number(a.correct)+1)}</p><p>نمره: ${fmt(a.score)}</p>` : `<p class="answer-text">${esc(a.text)}</p><form class="grade-form" data-submission="${esc(submission.id)}" data-question="${esc(a.question_id)}"><label>نمره پاسخ تشریحی<input name="score" type="number" required min="0" max="${esc(a.points)}" step="0.01" value="${a.score == null ? '' : esc(a.score)}"></label><button>ثبت نمره</button></form>`}</section>`).join('');
        detail.querySelectorAll('.grade-form').forEach(form => form.onsubmit = e => {
          e.preventDefault(); busy(form,async () => {
            const question = submission.answers.find(a => a.question_id === form.dataset.question);
            const value = Number(new FormData(form).get('score'));
            const updated = await rpc('grade_answer',{p_submission_id:submission.id,p_question_id:question.question_id,p_score:value});
            // Update this cached result and its existing DOM; keep the teacher's place.
            question.score = value;
            submission.total_score = updated.total_score;
            submission.status = updated.status;
            if (active()) {
              const row = [...app.querySelectorAll('[data-student-row]')].find(r => r.dataset.studentRow === submission.id);
              row.querySelector('.student-score').textContent = score(submission);
              row.querySelector('.student-status').textContent = status(submission);
              detail.querySelector('.summary-score').textContent = score(submission);
              notice('نمره ذخیره شد.');
            }
          });
        });
      });
    });
  } catch (e) {
    if (!active()) return;
    app.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p><button id="back">بازگشت</button></div>`;
    document.querySelector('#back').onclick = () => dashboard();
  }
}

async function student(id) {
  const active = startView('student');
  document.querySelector('#logout').hidden = true;
  app.innerHTML = loading('در حال دریافت آزمون…');
  try {
    const exam = await rpc('get_exam',{p_exam_id:Number(id)},false);
    if (!active()) return;
    app.innerHTML = `<div class="eyebrow">آزمون دانش‌آموز</div><h1>${esc(exam.title)}</h1><p>${fmt(exam.questions.length)} سؤال · لطفاً نام خود و همه پاسخ‌ها را وارد کنید.</p><form id="student-form"><div class="card"><div class="grid"><label>نام<input name="first_name" required maxlength="80" autocomplete="given-name"></label><label>نام خانوادگی<input name="last_name" required maxlength="80" autocomplete="family-name"></label></div><p class="muted">نام و پاسخ‌های شما فقط در اختیار معلم این آزمون قرار می‌گیرد. با نام واقعی خود وارد شوید.</p></div>${exam.questions.map((q,i) => `<section class="card question"><h3>${fmt(i+1)}. ${esc(q.prompt)}</h3><span class="badge">${fmt(q.points)} نمره</span>${q.type === 'mcq' ? q.options.map((o,j) => `<label class="option"><input type="radio" required name="q-${esc(q.id)}" value="${j}">${esc(o)}</label>`).join('') : `<label>پاسخ شما<textarea required name="q-${esc(q.id)}" maxlength="10000"></textarea></label>`}</section>`).join('')}<button type="submit">ثبت نهایی پاسخ‌ها</button><p class="muted">بعد از ثبت، پاسخ‌ها قابل ویرایش نیستند.</p></form>`;
    const form = document.querySelector('#student-form');
    form.onsubmit = e => { e.preventDefault(); busy(form,async () => {
      const f = new FormData(form); const answers = Object.fromEntries(exam.questions.map(q => [q.id,q.type === 'mcq' ? {choice:Number(f.get(`q-${q.id}`))} : {text:f.get(`q-${q.id}`).trim()}]));
      const receipt = await rpc('submit_exam',{p_exam_id:Number(id),p_first_name:f.get('first_name').trim(),p_last_name:f.get('last_name').trim(),p_answers:answers},false);
      if (!active()) return;
      startView('student');
      app.innerHTML = `<div class="card empty"><span class="badge">پاسخ‌ها ثبت شدند</span><h1>آزمون را به پایان رساندید</h1><p>معلم پاسخ‌های شما را دریافت کرده است و نمره نهایی را پس از تصحیح اعلام می‌کند.</p><p class="muted">کد پیگیری: ${esc(receipt.id || receipt.submission_id)}</p></div>`;
    }); };
  } catch (e) { if (!active()) return; app.innerHTML = `<div class="card"><h1>آزمون در دسترس نیست</h1><p class="error">${esc(e.message)}</p><button id="retry">تلاش مجدد</button></div>`; document.querySelector('#retry').onclick = () => student(id); }
}

async function boot() {
  if (!/^https:\/\/[a-z0-9.-]+/.test(config.supabaseUrl || '') || !config.supabaseKey) {
    app.innerHTML = '<div class="card"><h1>تنظیمات اتصال لازم است</h1><p>نشانی و کلید عمومی Supabase را در config.js قرار دهید.</p></div>'; return;
  }
  const id = location.pathname.match(/\/id\/([0-9]+)\/?$/)?.[1] || new URLSearchParams(location.search).get('exam');
  if (id && /^[0-9]{1,15}$/.test(id)) {
    history.replaceState(null,'',`${base}id/${id}`); await student(id);
  } else if (session?.access_token) { document.querySelector('#logout').hidden = false; await dashboard(); }
  else authView();
}
boot();
