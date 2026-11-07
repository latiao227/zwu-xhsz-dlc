// 智慧思政请假 · 纯函数层（不碰网络、不碰 DOM，可离线单测）。
//
// 存在的理由：模型不该自己做这几件事 ——
//   1. 把「明天上午」算成 2026-11-08 08:00-12:00（它常算错，且不知道今天几号）；
//   2. 把「发烧去医院」翻成 category（要先去查字典，白白多一轮对话）；
//   3. 判断「这张假条是不是和我已有的假条重叠」。
// 把这三件事压进工具内部，一次调用就能出一张可直接提交的草稿。
//
// ---------- 实测口径（2026-11-07）----------
// 站点请假单的时间是 `YYYY-MM-DD HH:mm` 字符串，且**起止都要带时分**；
// 天数（sky）按覆盖的日期个数算，不是按小时。

/** 请假时段。startTime / endTime 是站点要的格式。 */
export interface WhenSpan {
  startTime: string;
  endTime: string;
  /** 覆盖的日期个数（含头含尾）。 */
  days: number;
  /** 人话复述，直接放进确认卡，让用户一眼看出理解对不对。 */
  label: string;
  /** 是否真的从文本里解析出了日期；false 表示走了「明天全天」的默认值。 */
  parsed: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const addDays = (d: Date, n: number) => {
  const next = new Date(d.getTime());
  next.setDate(next.getDate() + n);
  return next;
};
const atHour = (d: Date, h: number, m = 0) => {
  const next = new Date(d.getTime());
  next.setHours(h, m, 0, 0);
  return next;
};

/** 一天之内的时段词 → [起, 止]（24 小时制）。 */
const SLOTS: Array<{re: RegExp; from: number; to: number; label: string}> = [
  {re: /(上午|早上|早晨|清晨)/, from: 8, to: 12, label: '上午'},
  {re: /(中午|午间)/, from: 11, to: 13, label: '中午'},
  {re: /(下午|午后)/, from: 13, to: 18, label: '下午'},
  {re: /(傍晚)/, from: 17, to: 19, label: '傍晚'},
  {re: /(晚上|夜里|晚间)/, from: 18, to: 21, label: '晚上'},
  {re: /(全天|整天|一天)/, from: 8, to: 18, label: '全天'}
];

const WD: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0
};

/** 归一化：全角→半角、去掉多余空白。 */
const normalize = (input: string) =>
  String(input || '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/[～~至]/g, '-')
    .replace(/\s+/g, '')
    .trim();

interface DayHit {
  date: Date;
  rest: string;
}

/** 从一段话里抠出「哪一天」。第二个返回值是抠掉日期词后的剩余文本，供时段解析用。 */
export function extractDay(raw: string, now = new Date()): DayHit | null {
  const text = normalize(raw);

  // 绝对日期：2026-11-08 / 2026/11/8 / 11月8日 / 11-8
  const abs = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text) || /(\d{4})年(\d{1,2})月(\d{1,2})日?/.exec(text);
  if (abs) {
    const date = new Date(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3]));
    if (!Number.isNaN(date.getTime())) return {date, rest: text.replace(abs[0], '')};
  }
  const md = /(\d{1,2})月(\d{1,2})日?/.exec(text) || /(?:^|[^\d])(\d{1,2})-(\d{1,2})(?:[^\d]|$)/.exec(text);
  if (md) {
    // 没写年份：取今年；如果算出来比今天早了 30 天以上，认为说的是明年。
    let date = new Date(now.getFullYear(), Number(md[1]) - 1, Number(md[2]));
    if (date.getTime() < now.getTime() - 30 * 86400000) date = new Date(now.getFullYear() + 1, Number(md[1]) - 1, Number(md[2]));
    if (!Number.isNaN(date.getTime())) return {date, rest: text.replace(md[0], '')};
  }

  // 相对日
  const rel: Array<[RegExp, number]> = [
    [/今天|今日|今晚|今早/, 0],
    [/明天|明日|明早|明晚/, 1],
    [/后天/, 2],
    [/大后天/, 3],
    [/昨天|昨日/, -1],
    [/前天/, -2]
  ];
  for (const [re, offset] of rel) {
    const hit = re.exec(text);
    if (hit) return {date: addDays(now, offset), rest: text.replace(hit[0], '')};
  }

  // 周几：下周三 / 这周三 / 本周三 / 周三
  const week = /(下下|下|这|本)?(?:周|星期|礼拜)([一二三四五六日天1-7])/.exec(text);
  if (week) {
    const target = WD[week[2]];
    const base = week[1] === '下' ? 1 : week[1] === '下下' ? 2 : 0;
    const current = now.getDay();
    let delta = (target - current + 7) % 7;
    if (base === 0 && delta === 0 && /下|这|本/.test(week[1] || '')) delta = 7;
    delta += base * 7;
    if (!/下|这|本/.test(week[1] || '') && delta === 0) delta = 7; // 「周三」说在今天就当下一周
    return {date: addDays(now, delta), rest: text.replace(week[0], '')};
  }

  return null;
}

export interface ClockTime {
  h: number;
  m: number;
}

/** 显式时刻：8点 / 8:30 / 8点到12点 / 08:00-12:00。 */
function extractClock(rest: string): {from: ClockTime | null; to: ClockTime | null; rest: string} {
  const text = rest;
  const range = /(\d{1,2})(?::(\d{2}))?(?:点|时|:|：)?(?:-|到)(\d{1,2})(?::(\d{2}))?(?:点|时)?/.exec(text);
  if (range) {
    return {
      from: {h: Number(range[1]), m: Number(range[2] || 0)},
      to: {h: Number(range[3]), m: Number(range[4] || 0)},
      rest: text.replace(range[0], '')
    };
  }
  const single = /(\d{1,2})(?::(\d{2}))?(?:点|时)/.exec(text);
  if (single) {
    return {from: {h: Number(single[1]), m: Number(single[2] || 0)}, to: null, rest: text.replace(single[0], '')};
  }
  return {from: null, to: null, rest: text};
}

/**
 * 把一句话解析成请假区间。
 *
 * 支持的写法（实测够用）：
 *   明天上午 / 今天下午 / 后天全天 / 周三 / 下周一
 *   2026-11-08 08:00-12:00 / 11月8日上午 / 明天8点到12点 / 明天到后天
 *
 * 都解析不出来 → 落到「明天全天」，并在 label 里说明这是默认值（确认卡会显示，用户能改）。
 */
export function parseWhen(raw: string, now = new Date()): WhenSpan {
  const text = normalize(raw);
  if (!text) return defaultSpan(now, false);

  // 日期区间：明天到后天 / 11-08-11-09（后者由两个绝对日期分别命中）
  const multi = /(今天|明天|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|下(?:周|星期|礼拜)[一二三四五六日天])-?(?:到|至|~)?(今天|明天|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|下(?:周|星期|礼拜)[一二三四五六日天])/.exec(text);

  let startDay: DayHit | null = null;
  let endDay: DayHit | null = null;
  let workRest = text;

  if (multi) {
    startDay = extractDay(multi[1], now);
    // 第二个日期相对**今天**算，不是相对第一个：「明天到后天」是两天，不是三天。
    endDay = extractDay(multi[2], now);
    workRest = text.replace(multi[0], '');
  } else {
    startDay = extractDay(text, now);
    if (startDay) workRest = startDay.rest;
  }

  const slot = SLOTS.find(item => item.re.test(workRest)) || null;
  const clock = extractClock(workRest);
  // 「下午3点」「晚上8点」说的是 12 小时制，必须换算，否则会生成 03:00 的假条。
  const isPm = /(下午|午后|傍晚|晚上|夜里|晚间|傍晚)/.test(workRest);

  const baseDay = startDay?.date || addDays(now, 1);
  const parsed = Boolean(startDay || slot || clock.from || clock.to);

  let fromH = slot ? slot.from : 8;
  let fromM = 0;
  let toH = slot ? slot.to : 18;
  let toM = 0;

  const cf = clock.from;
  const ct = clock.to;
  if (cf) {
    fromH = isPm && cf.h < 12 ? cf.h + 12 : cf.h;
    fromM = cf.m;
    // 只说了开始时间（「明天9点」）→ 默认 4 小时
    if (!ct) toH = Math.min(23, fromH + 4);
  }
  if (ct) {
    toH = isPm && ct.h < 12 ? ct.h + 12 : ct.h;
    toM = ct.m;
  }
  if (isPm && !cf && fromH < 12) fromH += 12;
  if (isPm && !ct && toH < 12) toH += 12;

  const start = atHour(baseDay, fromH, fromM);
  let end = atHour(endDay?.date || baseDay, toH, toM);
  if (end.getTime() <= start.getTime()) end = atHour(baseDay, Math.min(23, fromH + 4), fromM);

  const days = Math.max(1, Math.round((new Date(ymd(end)).getTime() - new Date(ymd(start)).getTime()) / 86400000) + 1);
  const label = `${ymd(start)} ${pad(fromH)}:${pad(fromM)} → ${ymd(end)} ${pad(toH)}:${pad(toM)}（${days} 天${slot ? '，' + slot.label : ''}${
    parsed ? '' : '，未识别到日期，默认明天全天'
  }）`;

  return {startTime: hm(start), endTime: hm(end), days, label, parsed};
}

function defaultSpan(now: Date, parsed: boolean): WhenSpan {
  const day = addDays(now, 1);
  return {
    startTime: hm(atHour(day, 8)),
    endTime: hm(atHour(day, 18)),
    days: 1,
    label: `${ymd(day)} 08:00 → ${ymd(day)} 18:00（1 天，未识别到日期，默认明天全天）`,
    parsed
  };
}

// ---------- 请假类型推断 ----------

export interface KindRule {
  category: string;
  label: string;
  re: RegExp;
}

/** 站点字典实测值（getLeaveTypes）：1 因病、2 因事、3 假期离校、4 因公、5 外出实习、6 延迟返校。 */
export const KIND_RULES: KindRule[] = [
  {category: '1', label: '因病请假', re: /(发烧|发热|感冒|咳嗽|头疼|头痛|肚子|腹泻|胃疼|呕吐|牙|眼|过敏|受伤|扭|骨折|手术|住院|看病|就医|医院|门诊|生病|不舒服|难受|阳了|复阳|甲流|流感|体检)/},
  {category: '3', label: '假期离校', re: /(放假|假期|回家|返乡|国庆|寒假|暑假|五一|中秋|端午|元旦|春节)/},
  {category: '4', label: '因公请假', re: /(比赛|竞赛|答辩|会议|活动|代表|演出|志愿|实践|出差|调研|训练)/},
  {category: '5', label: '外出实习', re: /(实习|实训|顶岗|企业实习)/},
  {category: '6', label: '延迟返校', re: /(延迟返校|晚回|赶不回来|车票|航班取消|误机|误车)/},
  {category: '2', label: '因事请假', re: /(事|办事|办证|面试|家事|家里|亲人|陪|送|接|搬家|考驾照|驾照|补考|重修|体检报告)/}
];

/** 从事由推断请假类型。推断不出就用 fallback（默认因事：最不容易被要求补材料）。 */
export function inferCategory(reason: string, fallback = '2'): {category: string; label: string; inferred: boolean; matched?: string} {
  for (const rule of KIND_RULES) {
    const hit = rule.re.exec(String(reason || ''));
    if (hit) return {category: rule.category, label: rule.label, inferred: true, matched: hit[0]};
  }
  return {category: fallback, label: fallback === '1' ? '因病请假' : '因事请假', inferred: false};
}

const CATEGORY_LABEL: Record<string, string> = {
  '1': '因病请假', '2': '因事请假', '3': '假期离校', '4': '因公请假', '5': '外出实习', '6': '延迟返校'
};

/** 字典值 → 中文名（字典取不到时兜底用）。 */
export const categoryLabel = (value: string) => CATEGORY_LABEL[String(value)] || String(value);

// ---------- 冲突检测 ----------

export interface SpanLike {
  startTime?: string;
  endTime?: string;
}
const toMs = (text?: string) => {
  if (!text) return NaN;
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(text));
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)).getTime();
};

/** 两张假条的时间是否重叠（用于提交前提醒「你已经有这段时间的假了」）。 */
export function overlaps(a: SpanLike, b: SpanLike): boolean {
  const a1 = toMs(a.startTime);
  const a2 = toMs(a.endTime);
  const b1 = toMs(b.startTime);
  const b2 = toMs(b.endTime);
  if ([a1, a2, b1, b2].some(Number.isNaN)) return false;
  return a1 <= b2 && b1 <= a2;
}

/** 是不是半天假（上午/下午/晚上）。整天假不值得按节次请 —— 按天更省事，也不用选课。 */
export function isPartialDay(startTime: string, endTime: string): boolean {
  const hourOf = (text: string) => {
    const m = /(\d{1,2}):(\d{2})/.exec(String(text).split(' ').slice(-1)[0] || String(text));
    return m ? Number(m[1]) + Number(m[2]) / 60 : NaN;
  };
  const from = hourOf(startTime);
  const to = hourOf(endTime);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  return to <= 12.5 || from >= 12.5;
}

/** 按天请假时后端也要求 lessons —— 每天一条空记录。 */
export function buildDefaultLessons(startTime: string, endTime: string): Array<{date: string; lessons: string; whether: number; latetime: string; remark: string}> {
  const days = expandDays(startTime, endTime);
  return days.map(date => ({date, lessons: '', whether: 0, latetime: '', remark: ''}));
}

export function expandDays(start: string, end: string): string[] {
  const toDate = (text: string) => {
    const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const a = toDate(start);
  const b = toDate(end) || a;
  if (!a || !b) return [ymd(new Date())];
  const out: string[] = [];
  for (let cursor = a.getTime(); cursor <= b.getTime() && out.length < 60; cursor += 86400000) out.push(ymd(new Date(cursor)));
  return out.length ? out : [ymd(new Date())];
}

/** 天数：优先用课程明细的天数，没有就按起止日期算（含头含尾）。 */
export function countDays(start: string, end: string, lessonDays?: number): number {
  if (lessonDays && lessonDays > 0) return lessonDays;
  return expandDays(start, end).length || 1;
}
