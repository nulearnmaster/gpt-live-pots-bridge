export const tasks = Object.freeze({
  'meeting-checklist': 'Draft a generic checklist for preparing for a meeting.',
  'weekly-review': 'Draft a generic weekly review checklist.',
  'follow-up-template': 'Draft a generic follow-up email template with placeholders. Do not send email.',
});

const phrases = new Map([
  ['queue meeting checklist end request', 'meeting-checklist'],
  ['queue weekly review checklist end request', 'weekly-review'],
  ['queue follow-up email template end request', 'follow-up-template'],
  ['queue follow up email template end request', 'follow-up-template'],
  ['회의 체크리스트 접수 요청 끝', 'meeting-checklist'],
  ['주간 리뷰 체크리스트 접수 요청 끝', 'weekly-review'],
  ['후속 이메일 양식 접수 요청 끝', 'follow-up-template'],
]);

export const idPattern = /^[A-Za-z0-9_-]{1,160}$/;
export const receiptPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const matchesExcerpt = (preset, excerpt) => isPreset(preset) && phrases.get(excerpt) === preset;
export const isPreset = (value) => typeof value === 'string' && Object.hasOwn(tasks, value);

export function matchRequest(fragments, offset) {
  const sorted = fragments.filter((f) => f.end >= offset - 12000 && f.start <= offset + 300)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const last = sorted.at(-1);
  if (!last || last.end < offset - 3500 || last.end > offset + 300) return null;
  let first = sorted.length - 1;
  while (first > 0 && sorted[first].start - sorted[first - 1].end <= 700) first--;
  const turn = sorted.slice(first);
  if (turn[0].start < offset - 12000 || turn.some((f, i) => i > 0 && f.start < turn[i - 1].end)) return null;
  const excerpt = turn.map((f) => f.text).join('').normalize('NFC').toLowerCase()
    .replace(/[,.!?，。？！]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const preset = phrases.get(excerpt);
  return preset ? { preset, excerpt } : null;
}

export function cleanResult(input, linkOrigin) {
  const { summary, link = null } = input;
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 1800 ||
      /[\p{Cf}\x00-\x09\x0b-\x1f\x7f]/u.test(summary) || /https?:\/\/|www\./iu.test(summary)) return null;
  if (link !== null) {
    if (!linkOrigin || typeof link !== 'string' || link.length > 512 || /[\p{C}\s]/u.test(link)) return null;
    try {
      const url = new URL(link);
      if (url.protocol !== 'https:' || url.origin !== linkOrigin || url.username || url.password ||
          url.search || url.hash || url.pathname === '/') return null;
      return { summary: summary.trim(), link: url.href };
    } catch { return null; }
  }
  return { summary: summary.trim(), link: null };
}
