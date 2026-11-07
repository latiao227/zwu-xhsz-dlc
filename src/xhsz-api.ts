// 智慧思政领域层（DLC: xhsz）。
//
// 站点：https://nxg.zwu.edu.cn/zhxg/  —— 浙江万里学院「智慧思政」，Vue SPA + 独立后端。
// 与我的万里（ehallapp）**完全是两套东西**，别把 G2JSONRequest / PostBackType 那套方言带过来。
//
// ---- 实测（2026-11-07，登录态）----
//
// 传输：
//   POST {HOST}/<模块>/<动作>，`application/x-www-form-urlencoded`，**全部是 POST，没有 GET**。
//   鉴权只有一条：`Authorization: Bearer <localStorage.token>`。
//   页面的 document.cookie 是空的 —— 不带这个头，服务端回 `{"msg":"请先登录智慧思政","code":401}`。
//
// 响应三种包装（同一个后端的心智模型不统一，见招拆招）：
//   A `{msg,code,data}`                  —— 大多数
//   B `{code,msg,data:null,dataList:[]}` —— 列表
//   C `{total,rows,code,msg,...}`        —— 分页（mybatis 风格）
//
// code 语义（重点，写错这一行会误判一半成功）：
//   0 / 200 / 201 / 202 都是成功；1 是业务态（"已签名"）；401 未登录；500 服务端异常。
//   请假提交成功是 **202**。
//
// 路径拼错不会 404：后端 fallback 回 HTML 页面（HTTP 200 + `<!DOCTYPE html>`），静默失败。
// 所以任何一次 `text()` 解析失败，都要按「路径写错了」处理，而不是「服务端坏了」。
//
// 图片：`POST {FILE_HOST}/wlxgFile/uploadFile`，multipart 字段名固定 `file`，
//   multipart 里**不带** Content-Type 头（交给浏览器自己加 boundary，手写会坏）。
//   返回 `{msg,code:0,fileName:"/profile/wlxgFile/YYYYMMDD/xxx.png"}`，
//   可访问地址 = `{FILE_HOST}` + fileName，实测回读 200。
import {getHost} from '../host';
import {NXG_HOST, NXG_FILE_HOST, requireToken, dropToken} from './xhsz-token';

/** 智慧思政的响应外壳。字段可选，因为三种包装都走这个类型。 */
export interface XhszEnvelope<T = any> {
  code?: number;
  msg?: string;
  data?: T;
  dataList?: any[];
  total?: number;
  rows?: any[];
  [key: string]: any;
}

/** 哪些 code 算成功。详见文件头「code 语义」。 */
export const isOk = (code: unknown): boolean => code === 0 || code === 200 || code === 201 || code === 202;

const TIMEOUT = 30_000;

/** 统一发请求：form 编码，带 Bearer，401 自动清票。 */
async function post<T = any>(path: string, body: Record<string, unknown> | string = '', signal?: AbortSignal): Promise<XhszEnvelope<T>> {
  const token = requireToken();
  const payload = typeof body === 'string' ? body : new URLSearchParams(
    Object.entries(body)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)])
  ).toString();

  const text = await send({
    method: 'POST',
    url: `${NXG_HOST}${path}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    data: payload,
    signal
  });

  const parsed = parseJson<T>(text, path);

  if (parsed.code === 401) {
    dropToken();
    throw new Error(`智慧思政登录态已过期（code 401）：${parsed.msg || '请重新登录'}。打开一次 https://nxg.zwu.edu.cn/zhxg/#/certificateLogin 会自动换票，回来重试即可。`);
  }
  return parsed;
}

/** 解析响应体；HTML 一律按「路径写错了」报错。 */
function parseJson<T>(text: string, path: string): XhszEnvelope<T> {
  const head = text.trimStart().slice(0, 20).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    throw new Error(`智慧思政返回了 HTML 而不是 JSON（路径 ${path}）。这个后端对不存在的接口不返回 404，而是回一个网页 —— 基本可以确定是路径写错了，不是服务端故障。`);
  }
  try {
    return JSON.parse(text) as XhszEnvelope<T>;
  } catch {
    throw new Error(`智慧思政响应不是 JSON（路径 ${path}）：${text.slice(0, 160)}`);
  }
}

/** 用宿主适配层发请求：油猴走 GM_xmlhttpRequest（无 CORS 限制），网页集成走 fetch。 */
function send(options: {method: string; url: string; headers: Record<string, string>; data?: string; signal?: AbortSignal}): Promise<string> {
  const host = getHost();
  if (options.signal?.aborted) return Promise.reject(new Error('已取消'));
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const router = host.request({
      method: options.method,
      url: options.url,
      headers: options.headers,
      data: options.data,
      timeout: TIMEOUT,
      // 智慧思政不靠 cookie 鉴权，带 cookie 只会让跨域请求变复杂。
      credentials: 'omit',
      onload: r => done(() => (r.status >= 200 && r.status < 400 ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}：${r.responseText.slice(0, 160)}`)))),
      onerror: r => done(() => reject(new Error(`${r.responseText || '请求失败'}`))),
      ontimeout: () => done(() => reject(new Error('智慧思政请求超时（30s）。'))),
      onabort: () => done(() => reject(new Error('已取消')))
    });
    const onAbort = () => {
      try {
        router.abort();
      } catch {}
      done(() => reject(new Error('已取消')));
    };
    options.signal?.addEventListener('abort', onAbort, {once: true});
  });
}

// ---------- 字典 ----------

export interface LeaveType {
  dictLabel: string;
  dictValue: string;
  dictType: string;
  dictSort?: number;
  status?: string;
  default?: boolean;
}

/**
 * 请假类型字典（事假/病假/假期离校/延迟返校…）。写假条时 `category` 就是这里的 dictValue。
 *
 * 加缓存（5 分钟）：字典是静态配置，但草稿、提交、回读一次流程里会问三遍。
 * 缓存对「字典被后台改了」这件事的容忍度是 5 分钟 —— 足够，而且能在确认卡上少一次往返。
 */
const TYPES_TTL = 5 * 60 * 1000;
let typesCache: {at: number; data: LeaveType[]} | null = null;

export async function getLeaveTypes(signal?: AbortSignal, refresh = false): Promise<LeaveType[]> {
  if (!refresh && typesCache && Date.now() - typesCache.at < TYPES_TTL) return typesCache.data;
  const r = await post<LeaveType[]>('/c/getLeaveTypes', 'status=2', signal);
  if (!isOk(r.code)) throw new Error(`取请假类型失败：${r.msg || r.code}`);
  const data = Array.isArray(r.data) ? r.data : [];
  typesCache = {at: Date.now(), data};
  return data;
}

// ---------- 请假 ----------

/**
 * 请假表单。字段名**必须**跟站点一致（这些是前端写死的，不是我们起的名字）。
 *
 * 关键几项：
 *  - `type`     1 = 按天，2 = 按节次
 *  - `category` 请假类型，取 getLeaveTypes 的 dictValue
 *  - `sky`      天数（= 覆盖的日期个数）
 *  - `lessons`  按节次请假时的课程明细，**JSON 字符串**，形如
 *               `[{"date":"2026-11-07","lessons":"高等数学,大学英语","whether":0,"latetime":"","remark":""}]`
 *  - `lessons`  **即使 type=1（按天）也必须传**，格式是 JSON 数组字符串。少这个字段后端直接
 *               回 `{"msg":"运行时异常:null","code":500}`，而且看不出缺什么。实测过的坑。
 *  - `leaveSchool` 1 = 外出（要填目的地/交通方式/返寝），2 = 不外出
 *  - `img`      凭证图，逗号分隔的 fileName（先走 uploadImage 拿）。**没有照片必被拒**：
 *               后端第一道校验就是照片，回 `{"msg":"请上传照片","code":500}`
 */
export interface LeaveForm {
  studentId: string;
  type: 1 | 2;
  category: string;
  startTime: string;
  endTime: string;
  sky: number;
  reason: string;
  img?: string;
  leaveSchool?: 1 | 2;
  destination?: string;
  goModel?: string;
  backModel?: string;
  arrange?: string;
  lessons?: string;
  inCity?: number;
  leaveSchoolTime?: string;
  liveAddressA?: string;
  liveAddressB?: string;
  liveAddressC?: string;
  isLesson?: number;
  urgent?: number;
  leaderImg?: string;
  homerImg?: string;
  [key: string]: unknown;
}

export interface LeaveSubmitResult {
  code: number;
  msg?: string;
  hint?: string;
  /** 后端要求补材料时，这里说明缺什么。 */
  need?: 'leader' | 'homer' | 'both' | null;
}

/**
 * 提交请假。
 *
 * 返回码（前端源码里写死的分支，别自己发明）：
 *   202 提交成功
 *   501 需导师同意书 → 补 `leaderImg` 再提一次
 *   502 需家长知情书 → 补 `homerImg` 再提一次
 *   503 两个都要      → 两张都补再提一次
 * 其它 → 失败，`msg` 是给人看的原因。
 *
 * ⚠️ 这个函数**只发一次请求**。501/502/503 的补材料重提由工具层按用户确认的结果决定，
 * 不在这里自动重试 —— 自动重提等于绕过确认闸门。
 */
export async function submitLeave(form: LeaveForm, signal?: AbortSignal): Promise<LeaveSubmitResult> {
  const r = await post('/s/leavesubmit', form as unknown as Record<string, unknown>, signal);
  const code = Number(r.code);
  const base: LeaveSubmitResult = {code, msg: r.msg};
  if (code === 202) return {...base, need: null};
  if (code === 501) return {...base, need: 'leader', hint: '后端要求补「导师同意书」'};
  if (code === 502) return {...base, need: 'homer', hint: '后端要求补「家长知情书」'};
  if (code === 503) return {...base, need: 'both', hint: '后端要求同时补「导师同意书」和「家长知情书」'};
  return base;
}

export interface LeaveRow {
  id: number | string;
  type?: number;
  studentId?: number;
  startTime?: string;
  endTime?: string;
  ytd?: string;
  reason?: string;
  status?: number | string;
  [key: string]: any;
}

/**
 * 我的请假列表。
 * `audit` 是服务端唯一的口径开关：1 = 待审核，2 = 已通过，3 = 已驳回/历史。
 * `isMelt`（1/2）只在 audit=2 下细分销假状态。
 */
export async function listLeaves(audit: 1 | 2 | 3, studentId: string, isMelt?: 1 | 2, signal?: AbortSignal): Promise<LeaveRow[]> {
  const query = new URLSearchParams({audit: String(audit), studentId});
  if (isMelt) query.set('isMelt', String(isMelt));
  const r = await post<LeaveRow[]>('/s/getleavelist', query.toString(), signal);
  if (!isOk(r.code)) throw new Error(`取请假列表失败：${r.msg || r.code}`);
  return Array.isArray(r.dataList) ? r.dataList : [];
}

/** 一条请假的详情。 */
export async function leaveDetail(id: string | number, studentId: string, signal?: AbortSignal): Promise<any> {
  const r = await post('/c/getleaveDetails', `leaveId=${encodeURIComponent(String(id))}&id=${encodeURIComponent(String(id))}&studentId=${encodeURIComponent(studentId)}`, signal);
  if (!isOk(r.code)) throw new Error(`取请假详情失败：${r.msg || r.code}`);
  return r.data;
}

/** 销假（请假已通过后，提前结束/返校报到时用）。 */
export async function meltLeave(leaveId: string | number, signal?: AbortSignal): Promise<XhszEnvelope> {
  return post('/s/meltLeave', {leaveId: String(leaveId)}, signal);
}

/** 返校登记（离校假到期回校）。 */
export async function returnLeave(leaveId: string | number, reason: string, signal?: AbortSignal): Promise<XhszEnvelope> {
  return post('/s/returnLeave', {leaveId: String(leaveId), reason}, signal);
}

/**
 * 通用动作调用（受控写执行器用）。
 *
 * 只做一件事：把 path + payload 原样 form-encode 发出去，把 envelope 还回来。
 * **白名单校验在工具层（xhsz-form.ts），不在这里** —— 这层保持无心智、可复用。
 */
export async function postAction(path: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<XhszEnvelope> {
  return post(path, payload, signal);
}

/** 被驳回后重新提交。 */
export async function resubmitLeave(form: {studentId: string; leaveId: string | number; reason: string; type?: string; title?: string; content?: string; img?: string; leaderImg?: string; homerImg?: string}, signal?: AbortSignal): Promise<XhszEnvelope> {
  return post('/s/leaveResubmit', form as unknown as Record<string, unknown>, signal);
}

// ---------- 勤工助学（学生端）----------
//
// 三个只读：在岗岗位、报名记录、月度意见状态；一个写：提交月度意见。
// 实测（2026-11-07）：`eval/studentOpinionStatus` 一个月一条，`goLiveMonth` 之前不给填。

export interface WorkAidJob {
  id: string | number;
  jobName?: string;
  deptName?: string;
  status?: string | number;
  [key: string]: any;
}

/** 我通过审核的在岗岗位（含 applyId，月度意见要它）。 */
export async function listWorkAidJobs(studentId: string, signal?: AbortSignal): Promise<WorkAidJob[]> {
  const r = await post('/c/workAid/job/stuApplyPassJobList', {studentId}, signal);
  if (!isOk(r.code)) throw new Error(`取勤工助学岗位失败：${r.msg || r.code}`);
  const data = Array.isArray(r.data) ? r.data : [];
  return data as WorkAidJob[];
}

/** 本月意见填了没。 */
export async function workAidOpinionStatus(studentId: string, monthKey: string, signal?: AbortSignal): Promise<any> {
  const r = await post('/c/workAid/eval/studentOpinionStatus', {studentId, monthKey}, signal);
  if (!isOk(r.code)) throw new Error(`取勤工助学月度状态失败：${r.msg || r.code}`);
  return r.data ?? {};
}

/** 提交月度意见（写）。 */
export async function submitWorkAidOpinion(
  input: {studentId: string; applyId: string | number; monthKey: string; hasSuggestion: boolean; content: string},
  signal?: AbortSignal
): Promise<XhszEnvelope> {
  return post('/c/workAid/eval/submitStudentOpinion', {
    ...input,
    hasSuggestion: input.hasSuggestion ? 1 : 0
  }, signal);
}

/** 我报名过的勤工助学岗位（含待审/已通过的记录）。 */
export async function listWorkAidApplies(studentId: string, signal?: AbortSignal): Promise<WorkAidJob[]> {
  const r = await post('/c/workAid/job/stuApplyJobList', {studentId}, signal);
  if (!isOk(r.code)) throw new Error(`取勤工助学报名记录失败：${r.msg || r.code}`);
  return (Array.isArray(r.data) ? r.data : []) as WorkAidJob[];
}

/**
 * 撤回勤工助学岗位报名（写）。
 * 字段就两个：`id`（报名记录 id，不是岗位 id）+ `studentId`。站点前端还带了一堆 UI 回调字段，不带也行。
 */
export async function withdrawWorkAidApply(id: string | number, studentId: string, signal?: AbortSignal): Promise<XhszEnvelope> {
  return post('/c/workAid/apply/withdraw', {id: String(id), studentId}, signal);
}

// ---------- 图片 ----------

/**
 * 上传一张凭证图，返回 fileName（形如 `/profile/wlxgFile/20261107/xxx.png`）。
 *
 * 注意两件事：
 *  1. **不要手写 Content-Type**。multipart 的 boundary 必须由浏览器生成，手写 `multipart/form-data`
 *     会把 boundary 弄丢，服务端直接拒。
 *  2. 这里用 dataUrl（`data:image/png;base64,...`）而不是 File 对象，因为工具层的入参是
 *     对话里贴进来的附件，天然就是 dataUrl，转成 File 只为满足 FormData。
 */
export async function uploadImage(dataUrl: string, filename = 'evidence.png', signal?: AbortSignal): Promise<string> {
  const token = requireToken();
  const match = /^data:([^;,]+)?;base64,([\s\S]*)$/.exec(dataUrl);
  if (!match) throw new Error('附件不是合法的图片数据（期望 data:image/...;base64,...）。');
  const mime = match[1] || 'image/png';
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const form = new FormData();
  form.append('file', new File([bytes], filename, {type: mime}));

  const text = await sendMultipart(`${NXG_FILE_HOST}/wlxgFile/uploadFile`, form, token, signal);
  const parsed = parseJson(text, '/wlxgFile/uploadFile');
  if (!isOk(parsed.code) || !parsed.fileName) {
    throw new Error(`图片上传失败：${parsed.msg || parsed.code || '未知错误'}`);
  }
  return String(parsed.fileName);
}

/** multipart 单独走一条路：GM_xmlhttpRequest 支持传 FormData，网页 fetch 也支持。 */
function sendMultipart(url: string, form: FormData, token: string, signal?: AbortSignal): Promise<string> {
  const host = getHost();
  if (optionsAlive(signal) === false) return Promise.reject(new Error('已取消'));
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const router = host.request({
      method: 'POST',
      url,
      headers: {Authorization: `Bearer ${token}`},
      // FormData 直接作为 data 传下去：适配层不设 Content-Type，由浏览器生成 boundary。
      data: form as unknown as string,
      timeout: TIMEOUT,
      credentials: 'omit',
      onload: r => done(() => (r.status >= 200 && r.status < 400 ? resolve(r.responseText) : reject(new Error(`上传失败 HTTP ${r.status}`)))),
      onerror: r => done(() => reject(new Error(r.responseText || '上传失败'))),
      ontimeout: () => done(() => reject(new Error('图片上传超时（30s）。'))),
      onabort: () => done(() => reject(new Error('已取消')))
    });
    signal?.addEventListener('abort', () => {
      try {
        (router as any).abort?.();
      } catch {}
      done(() => reject(new Error('已取消')));
    }, {once: true});
  });
}

const optionsAlive = (signal?: AbortSignal): boolean => !signal?.aborted;
