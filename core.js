export function normalizeUsername(value) {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new Error('نام کاربری باید ۳ تا ۳۲ حرف انگلیسی، عدد یا زیرخط باشد.');
  return username;
}
export function normalizeDigits(value) {
  return value.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}
export function validateQuestions(questions) {
  if (!questions.length || questions.length > 100) throw new Error('آزمون باید بین ۱ تا ۱۰۰ سؤال داشته باشد.');
  return questions.map(q => {
    if (!q.prompt.trim() || q.prompt.length > 5000 || !Number.isFinite(Number(q.points)) || Number(q.points) <= 0 || Number(q.points) > 100 || Math.abs(Number(q.points)*100 - Math.round(Number(q.points)*100)) > 1e-7) throw new Error('متن و بارم معتبر با حداکثر دو رقم اعشار برای هر سؤال لازم است.');
    const result = {type:q.type,prompt:q.prompt.trim(),points:Number(q.points)};
    if (!['mcq','essay'].includes(q.type)) throw new Error('نوع سؤال نامعتبر است.');
    if (q.type === 'mcq') {
      if (q.options.length !== 4 || q.options.some(o => !o.trim() || o.length > 1000) || !Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) throw new Error('چهار گزینه و تیک پاسخ صحیح را وارد کنید.');
      result.options = q.options.map(o => o.trim()); result.correct = q.correct;
    }
    return result;
  });
}
export function examLink(origin, base, id) {
  if (!/^[0-9]+$/.test(String(id))) throw new Error('شناسه نامعتبر');
  return `${origin}${base}id/${id}`;
}
