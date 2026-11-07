// 智慧思政 · 课表桥（给按节次请假自动填 lessons 用）。
//
// ---------- 为什么不能直接 fetch ----------
//
// 课表在「上课啦」那一套里，接口挂在**我的万里**（ehallapp）域名下：
//   POST /_layouts/15/ZWUWSBS/AppApi/SKL/AttendanceApi.aspx   (PostBackType=getTeaDateCourseList)
//   POST /_layouts/15/ZWUWSBS/AppApi/SKL/SchoolCalendarApi.aspx (getSchoolWhichWeek)
//
// 但请假是在**智慧思政**（nxg）域名下操作的。两个域之间：
//   - localStorage 不共享（所以 token 得单独桥一次）；
//   - fetch 会被 CORS 拦（实测：主世界和 content script 里都是 `Failed to fetch`）。
//
// 唯一稳的路是扩展的 service worker：它走 host_permissions，不受 CORS 限制，
// 而且 `credentials:'include'` 能带上 ehallapp 的 SharePoint 登录 cookie（实测 200）。
// 所以这里通过 `chrome.runtime.sendMessage({type:'zwu.skl.fetch'})` 请后台代发，
// 后台只放行 SKL 只读动作 + AuthApi.CurrentUser（见 chrome-extension/background.js）。
//
// 油猴版没有 service worker → 这条路走不通，降级为「让用户说清楚哪几节课」，
// 不影响按天请假。
//
// ---------- 数据形状（实测 2026-11-07）----------
//
// getTeaDateCourseList 传 DateE='' 会返回**整学期**排课（实测 232 条 / ~230KB）：
//   {DateE:"2026-10-18", WeekNum:"5", DayWeek:"7", Lesson:"1-4",
//    StartLesson:1, EndLesson:4, CourseName:"大学英语4", TeacherName:"刘俊辉",
//    RoomName:"钱湖1410(多)"}
// 同一节课挂多个老师会返回多条（TeachingClassDateLesson 相同），要按它合并。

const SKL_ATTENDANCE = '/_layouts/15/ZWUWSBS/AppApi/SKL/AttendanceApi.aspx';
const SKL_CALENDAR = '/_layouts/15/ZWUWSBS/AppApi/SKL/SchoolCalendarApi.aspx';
const AUTH_API = '/_layouts/15/ZWUWSBS/AppApi/System/AuthApi.aspx';

export interface CourseSlot {
  date: string;
  lesson: string;
  startLesson: number;
  endLesson: number;
  course: string;
  teachers: string[];
  room: string;
}

export interface TimetableSnapshot {
  year: string;
  semester: string;
  week: string;
  slots: CourseSlot[];
  fetchedAt: number;
  /** 学号（LoginName）。排课接口必须带，否则会拿全校课表。 */
  loginName: string;
}

/** 后台代发的返回。 */
interface SkzReply {
  ok?: boolean;
  status?: number;
  text?: string;
  error?: string;
}

const runtime = (): any => (globalThis as any).chrome?.runtime;

/** 当前是不是跑在扩展里（有 service worker 可代发跨域请求）。 */
export const hasBackgroundBridge = (): boolean =>
  typeof runtime()?.sendMessage === 'function' && typeof runtime()?.id === 'string';

/** 请后台代发一次 SKL 请求，返回解析后的 `Data`。 */
async function sklFetch<T = unknown>(path: string, body: Record<string, unknown>): Promise<T | null> {
  const api = runtime();
  if (!api?.sendMessage) {
    throw new Error('当前环境没有扩展后台（油猴版），拿不到课表。');
  }
  const reply: SkzReply = await new Promise(resolve => {
    try {
      api.sendMessage({type: 'zwu.skl.fetch', path, body}, (response: SkzReply) => resolve(response || {error: '后台没有回包'}));
    } catch (error) {
      resolve({error: String((error as Error).message || error)});
    }
  });
  if (!reply.ok) throw new Error(reply.error || '后台代发失败');
  const text = String(reply.text || '');
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new Error('「我的万里」登录态失效了（接口回了登录页）。先去 ehallapp 页面登录一次。');
  }
  let parsed: {RetCode?: number; Data?: T; Message?: string};
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`课表接口返回的不是 JSON：${text.slice(0, 120)}`);
  }
  if (parsed.RetCode !== 0) throw new Error(`课表接口返回 RetCode=${parsed.RetCode}：${parsed.Message || ''}`);
  return (parsed.Data ?? null) as T | null;
}

function splitMulti(value: unknown): string[] {
  return String(value ?? '')
    .split(/[;,]/)
    .map(item => item.trim())
    .filter(Boolean);
}

/** 内存缓存：同一次会话里出几张草稿不该反复拉 230KB。 */
let cache: TimetableSnapshot | null = null;
const CACHE_TTL = 10 * 60 * 1000;

/**
 * 拉整学期课表。按学期缓存 10 分钟。
 *
 * 三步：CurrentUser 拿学号 → getSchoolWhichWeek 拿当前学年/学期/周 → 拉整学期排课。
 * 任何一步失败都抛错，由调用方决定降级成「按天请假」还是提示用户。
 */
export async function loadTimetable(force = false): Promise<TimetableSnapshot> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL) return cache;

  const me = await sklFetch<Record<string, unknown>>(AUTH_API, {PostBackType: 'CurrentUser'});
  const loginName = String(me?.LoginName ?? '').trim();
  if (!loginName) throw new Error('取不到当前账号的学号（AuthApi 没返回 LoginName），没法限定课表范围。');

  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayText = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  const weeks = await sklFetch<Record<string, unknown>[]>(SKL_CALENDAR, {
    PostBackType: 'getSchoolWhichWeek',
    StartDate: todayText,
    EndDate: todayText
  });
  const marked = (weeks ?? []).find(row => row.IsToday === true) ?? (weeks ?? [])[0];
  const year = String(marked?.SchoolYear ?? '').trim();
  const semester = String(marked?.Semester ?? '').trim();
  const week = String(marked?.WhichWeek ?? '').trim();
  if (!year || !semester) throw new Error('拿不到当前学年学期（校历接口没返回），课表没法查。');

  const rows = await sklFetch<Record<string, unknown>[]>(SKL_ATTENDANCE, {
    PostBackType: 'getTeaDateCourseList',
    DateE: '',
    TeaAccount: '',
    SchoolYear: year,
    Semester: semester,
    StudentId: loginName,
    ActionCode: ''
  });

  // 同一节课多老师会重复，按「教学班码_日期_节次」合并。
  const merged = new Map<string, CourseSlot>();
  for (const raw of rows ?? []) {
    const date = String(raw.DateE ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const key = String(raw.TeachingClassDateLesson ?? `${raw.CourseName}_${date}_${raw.Lesson}`);
    const course = String(raw.CourseName ?? '').trim();
    const existing = merged.get(key);
    if (existing) {
      for (const teacher of splitMulti(raw.TeacherName)) if (!existing.teachers.includes(teacher)) existing.teachers.push(teacher);
      continue;
    }
    merged.set(key, {
      date,
      lesson: String(raw.Lesson ?? '').trim(),
      startLesson: Number(raw.StartLesson) || 0,
      endLesson: Number(raw.EndLesson) || 0,
      course,
      teachers: splitMulti(raw.TeacherName),
      room: splitMulti(raw.RoomName).join('、')
    });
  }

  const slots = [...merged.values()]
    .filter(slot => slot.course)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startLesson - b.startLesson);

  cache = {year, semester, week, slots, fetchedAt: Date.now(), loginName};
  return cache;
}

/** 清缓存（换账号/换学期时用）。 */
export const clearTimetableCache = () => {
  cache = null;
};

/**
 * 某一天的课 → 节次段。
 *
 * 站点不返回每节课的钟点，只有节次号。这里按学校作息粗分：
 * 1-4 节算上午，5-8 节算下午，9 节及以后算晚上。够用来判断
 * 「用户请的是上午的假，所以只该填上午那几门课」。
 */
function bandOf(startLesson: number): 'am' | 'pm' | 'night' {
  if (startLesson <= 4) return 'am';
  if (startLesson <= 8) return 'pm';
  return 'night';
}

/** 从请假时段推断用户关心哪个半天（避免把全天的课都塞进「只请上午」的假条）。 */
function wantedBands(startTime: string, endTime: string): Set<'am' | 'pm' | 'night'> {
  const hourOf = (text: string) => {
    const m = /(\d{2}):(\d{2})/.exec(text.split(' ')[1] || '');
    return m ? Number(m[1]) + Number(m[2]) / 60 : NaN;
  };
  const from = hourOf(startTime);
  const to = hourOf(endTime);
  const bands = new Set<'am' | 'pm' | 'night'>();
  if (Number.isNaN(from) || Number.isNaN(to)) return new Set(['am', 'pm', 'night']);
  if (to <= 12.5) bands.add('am');
  else if (from >= 12.5 && to <= 18.5) bands.add('pm');
  else if (from >= 18.5) bands.add('night');
  else {
    bands.add('am');
    bands.add('pm');
    if (to > 18.5) bands.add('night');
  }
  return bands;
}

export interface LessonRow {
  date: string;
  lessons: string;
  whether: number;
  latetime: string;
  /** 提交给站点的 note 字段。**必须留空** —— 站点把它当成"备注"显示给辅导员，塞节次号会露出来。 */
  remark: string;
  /** 节次串（如 `1-4`），只用于确认卡展示，不提交。 */
  lesson: string;
}

export interface LessonsFromTimetable {
  rows: LessonRow[];
  /** 一共命中几门课（按天去重后统计）。 */
  hitCount: number;
  /** 没有课的天数（这些天 lessons 是空的，但记录仍要补，后端要求每天一条）。 */
  emptyDays: number[];
  /** 课表命中情况的人话描述，直接进确认卡。 */
  summary: string;
}

/**
 * 按请假区间从课表生成 `lessons`。
 *
 * 只有「命中课程」才写课程名；没课的天写空串 —— 但**每一天都要有一条记录**，
 * 因为后端把 lessons 当成必填字段，缺了回 `运行时异常:null`。
 */
export function lessonsFromTimetable(snapshot: TimetableSnapshot, startTime: string, endTime: string): LessonsFromTimetable {
  const days = expandDates(startTime, endTime);
  const bands = wantedBands(startTime, endTime);
  const rows: LessonRow[] = [];
  const emptyDays: number[] = [];
  let hitCount = 0;

  for (const day of days) {
    const matched = snapshot.slots
      .filter(slot => slot.date === day)
      .filter(slot => bands.has(bandOf(slot.startLesson)));
    const names: string[] = [];
    for (const slot of matched) if (!names.includes(slot.course)) names.push(slot.course);
    if (!names.length) emptyDays.push(days.indexOf(day) + 1);
    hitCount += names.length;
    rows.push({
      date: day,
      lessons: names.join(','),
      whether: 0,
      latetime: '',
      // 备注留空：站点会把 remark 原样显示在请假单上，塞节次号等于在事由里插一行怪文字。
      remark: '',
      lesson: names.length ? matched.map(slot => slot.lesson).filter((v, i, a) => a.indexOf(v) === i).join(',') : ''
    });
  }

  const bandText = [...bands].map(band => (band === 'am' ? '上午' : band === 'pm' ? '下午' : '晚上')).join('+');
  const summary = hitCount
    ? `课表（${snapshot.year} 第${snapshot.semester}学期 · 第${snapshot.week}周）里，这段时间的${bandText}共 ${hitCount} 门课：` +
      rows.filter(row => row.lessons).map(row => `${row.date.slice(5)} ${row.lessons}`).join('；')
    : `课表（${snapshot.year} 第${snapshot.semester}学期）里，这段时间的${bandText}没有课`;

  return {rows, hitCount, emptyDays, summary};
}

function expandDates(start: string, end: string): string[] {
  const toDate = (text: string) => {
    const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const a = toDate(start);
  const b = toDate(end) || a;
  if (!a || !b) return [];
  const out: string[] = [];
  for (let cursor = a.getTime(); cursor <= b.getTime() && out.length < 60; cursor += 86400000) {
    const d = new Date(cursor);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

// ---------- 考勤对账（xhsz_leave_guard 用）----------
//
// `getStuCourseList` 给的是**每门课整学期的计数**（Total/Arrived/Late/Early/Truant/Leave），
// 没有按日期明细。所以对账只能回答「这几门课你本学期已经请过几次假、旷过几次课」，
// 回答不了「这一节课当天到底算不算」。这一层边界必须如实写在输出里，别让模型编。

export interface AttendanceCourse {
  course: string;
  teachers: string[];
  total: number;
  arrived: number;
  late: number;
  early: number;
  truant: number;
  leave: number;
}

let attendanceCache: {at: number; year: string; semester: string; rows: AttendanceCourse[]} | null = null;

export async function loadAttendance(year: string, semester: string, force = false): Promise<AttendanceCourse[]> {
  if (!force && attendanceCache && attendanceCache.year === year && attendanceCache.semester === semester && Date.now() - attendanceCache.at < CACHE_TTL) {
    return attendanceCache.rows;
  }
  const rows = await sklFetch<Record<string, unknown>[]>(SKL_ATTENDANCE, {
    PostBackType: 'getStuCourseList',
    SchoolYear: year,
    Semester: semester,
    StudentId: '',
    courseName: ''
  });
  const parsed: AttendanceCourse[] = (rows ?? []).map(raw => ({
    course: String(raw.CourseName ?? '').trim(),
    teachers: splitMulti(raw.TeacherName),
    total: Number(raw.TotalCount) || 0,
    arrived: Number(raw.ArrivedCount) || 0,
    late: Number(raw.LateCount) || 0,
    early: Number(raw.EarlyCount) || 0,
    truant: Number(raw.TruantCount) || 0,
    leave: Number(raw.LeaveCount) || 0
  })).filter(row => row.course);
  attendanceCache = {at: Date.now(), year, semester, rows: parsed};
  return parsed;
}

export const clearAttendanceCache = () => {
  attendanceCache = null;
};

export interface GuardRow {
  date: string;
  lesson: string;
  course: string;
  teachers: string;
  room: string;
  /** 这门课整学期的请假次数（含这次还没生效的）。 */
  leaveCount: number;
  truantCount: number;
  lateCount: number;
  /** 一句话结论。 */
  verdict: string;
}

export interface GuardResult {
  rows: GuardRow[];
  /** 这段假一共影响多少节课。 */
  lessonCount: number;
  /** 需要注意的点（旷课记录、跨周末、离校类等）。 */
  flags: string[];
  summary: string;
}

/**
 * 请假 × 课表 × 考勤 三方核对。
 *
 * 回答三个问题：
 *   1. 这段假到底会漏掉哪几节课（精确：日期 + 节次 + 课程）；
 *   2. 这些课这学期你请过几次假、旷过几次课（考勤口径）；
 *   3. 有没有「先被记旷课、再补假条」这种补不回来的情况要提前知道。
 */
export function auditSpan(snapshot: TimetableSnapshot, attendance: AttendanceCourse[], startTime: string, endTime: string): GuardResult {
  const days = expandDates(startTime, endTime);
  const bands = wantedBands(startTime, endTime);
  const rows: GuardRow[] = [];
  const flags: string[] = [];

  for (const day of days) {
    for (const slot of snapshot.slots) {
      if (slot.date !== day) continue;
      if (!bands.has(bandOf(slot.startLesson))) continue;
      const stat = attendance.find(item => item.course === slot.course);
      const leaveCount = stat?.leave ?? 0;
      const truantCount = stat?.truant ?? 0;
      const lateCount = stat?.late ?? 0;
      let verdict = '正常覆盖';
      if (!stat) verdict = '考勤里没有这门课的记录';
      else if (truantCount > 0) verdict = `这门课已有 ${truantCount} 次旷课记录 —— 请假不会自动销掉旷课`;
      else if (lateCount > 0) verdict = `这门课有 ${lateCount} 次迟到 —— 迟到和请假是两套计数`;
      rows.push({
        date: day,
        lesson: slot.lesson,
        course: slot.course,
        teachers: slot.teachers.join('、'),
        room: slot.room,
        leaveCount,
        truantCount,
        lateCount,
        verdict
      });
    }
  }

  const uniqueCourses = new Set(rows.map(row => row.course));
  const withTruant = [...uniqueCourses].filter(course => (attendance.find(item => item.course === course)?.truant ?? 0) > 0);
  if (withTruant.length) flags.push(`${withTruant.join('、')} 这学期已经有旷课记录。补假条通常不会自动改考勤，需要找任课老师或辅导员处理。`);
  if (!rows.length) flags.push('这段时间课表里没有课 —— 按天请假就够了，不用选课。');
  const weekend = days.filter(day => [0, 6].includes(new Date(day).getDay()));
  if (weekend.length && rows.length) flags.push(`${weekend.join('、')} 是周末，请确认这几天的课确实要请（有些是补课或调课）。`);

  const summary = rows.length
    ? `这段假会影响 ${rows.length} 节课（${uniqueCourses.size} 门课）：` +
      rows.map(row => `${row.date.slice(5)} ${row.lesson} ${row.course}`).join('；')
    : '这段假不影响任何课程。';

  return {rows, lessonCount: rows.length, flags, summary};
}
