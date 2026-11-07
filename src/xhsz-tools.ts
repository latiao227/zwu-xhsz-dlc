// 智慧思政（DLC: xhsz）工具层。
//
// 六个工具，四个只读、两个写：
//   xhsz_leave_types   请假类型字典（诊断用，正常流程不用先调）  read
//   xhsz_leave_draft   一句话出假条草稿 + 确认卡               fill
//   xhsz_leave_submit  提交草稿（自动回读单号与审批状态）        act
//   xhsz_leave_list    我的请假列表                           read
//   xhsz_leave_detail  一条请假的详情                         read
//   xhsz_leave_close   销假 / 返校登记                        act
//
// ---------- 为什么写操作是两步 ----------
//
// 站点**没有撤回接口**：`/s/returnLeave` 是返校、`/s/meltLeave` 是销假，都要求单子先成立。
// 一张错假条发出去，只能等辅导员驳回，期间考勤状态是错的。所以：
//
//   draft  → 生成草稿，返回一张**确认卡**（类型/起止/事由/课程/照片），不碰服务端
//   submit → 必须带 `draft_id` + `confirm: true`，草稿 10 分钟内有效
//
// 再加上主仓的授权闸门（riskOf 声明 act 会自动弹授权），一共两道闸：
// 第一道是模型不能自己点提交，第二道是提交的内容必须是用户看过的那张草稿。
//
// ---------- 目标：两句对话办完 ----------
//
// 旧的流程要 4~5 轮：查字典 → 发现没图 → 要图 → 出草稿 → 提交。
// 现在压成 2 轮，靠的是把「模型做不好、也不该做」的事挪进工具内部（见 xhsz-leave.ts）：
//
//   轮 1  用户：「我明天上午发烧要去医院，帮我请个假」（顺手贴了病历图）
//         模型：xhsz_leave_draft({when:'明天上午', reason:'发烧要去医院'})
//         工具：解析时间、从事由推断 category=1 因病、自动捞最近的附件当凭证、
//               检查是否与已有假条重叠、补齐 lessons → 回一张确认卡
//   轮 2  用户：「提交」
//         模型：xhsz_leave_submit({draft_id, confirm:true})
//         工具：上传图 → 提交 → 自动回读单号与审批状态（短假会显示「已自动通过」）
//
// 模型不需要知道今天几号，不需要先查字典，也不需要问「有没有照片」。
//
// ---------- 501 / 502 / 503 ----------
//
// 后端会因为缺材料拒绝：501 缺导师同意书、502 缺家长知情书、503 两个都缺。
// 这不是错误，是规则。**不自动补材料重提** —— 补材料意味着换一张新单子重新提交，
// 必须让用户看过再走一次 submit。
//
// 但**草稿不作废**：501/502/503 之后同一张草稿仍然可用，带上 leader_photo_path /
// homer_photo_path 再提交一次即可。旧版把草稿标成 used 就直接废了，用户要重新说一遍
// 事由、重新贴图，体验很差 —— 这里改掉。
import {registerSeries} from './index';
import {schema, str, int, bool} from './contract';
import type {SeriesModule} from './contract';
import {readDataUrl, listFiles} from '../vfs';
import {
  getLeaveTypes, submitLeave, listLeaves, leaveDetail, meltLeave, returnLeave, uploadImage,
  resubmitLeave, listWorkAidJobs, workAidOpinionStatus, submitWorkAidOpinion,
  listWorkAidApplies, withdrawWorkAidApply, postAction, isOk
} from './xhsz-api';
import type {LeaveForm, LeaveSubmitResult} from './xhsz-api';
import {renderLeaveTypes, renderDraft, renderSubmit, renderLeaveList, renderLeaveDetail, renderClose, renderResubmitDraft, renderResubmitResult, renderWriteDraft, renderWriteResult} from './xhsz-render';
import type {DraftView} from './xhsz-render';
import {requireStudentId} from './xhsz-token';
import {
  parseWhen, inferCategory, categoryLabel, buildDefaultLessons, countDays, overlaps, isPartialDay
} from './xhsz-leave';
import type {WhenSpan} from './xhsz-leave';
import {loadTimetable, loadAttendance, lessonsFromTimetable, auditSpan, hasBackgroundBridge} from './xhsz-lessons';
import {renderGuard} from './xhsz-render';
import {findGuide, renderGuide} from './xhsz-guide';
import {findFormAction, listFormActions, checkPayload, renderFormActions} from './xhsz-form';

export const XHSZ_TOOL_NAMES = [
  'xhsz_leave_types', 'xhsz_leave_draft', 'xhsz_leave_guard', 'xhsz_leave_submit',
  'xhsz_leave_list', 'xhsz_leave_detail', 'xhsz_leave_close',
  'xhsz_leave_resubmit_draft', 'xhsz_leave_resubmit',
  'xhsz_workaid_opinion_draft', 'xhsz_workaid_opinion',
  'xhsz_workaid_withdraw_draft', 'xhsz_workaid_withdraw',
  'xhsz_guide',
  'xhsz_form_actions', 'xhsz_form_draft', 'xhsz_form_submit'
] as const;

// ---------- 草稿仓 ----------
//
// 进程内存储，一次性。不放 KV：草稿里可能有"发烧去医院"这种隐私描述，
// 落盘等于把它留在了浏览器里。10 分钟没用就扔掉。

interface Draft {
  id: string;
  form: LeaveForm;
  categoryLabel: string;
  lessons?: Array<{date: string; lessons: string; remark?: string}>;
  photos: Array<{role: 'evidence' | 'leader' | 'homer'; dataUrl: string; name: string}>;
  /** 解析出来的人话时间，确认卡上显示。 */
  spanLabel?: string;
  /** 课表命中情况（「上午共 2 门课：11-08 大学英语、高等数学」）。 */
  lessonSummary?: string;
  /** 出草稿时发现的风险（时间重叠、没照片等），确认卡上一起显示。 */
  warnings: string[];
  createdAt: number;
  /** 已经成功提交过（防重复）。 */
  used: boolean;
  /** 提交失败的次数（501/502/503 不计入）。 */
  attempts: number;
}

const DRAFT_TTL = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const drafts = new Map<string, Draft>();

// ---------- 通用写草稿仓（请假之外的写技能共用）----------
//
// 请假那条链有自己的 LeaveForm 草稿。其它写操作（驳回重提、岗位报名、学分申报…）
// 形状各不相同，用这个通用仓：只存「确认卡正文 + 待发 payload + 待上传照片」。

export interface WriteDraft {
  id: string;
  kind: string;
  title: string;
  preview: string;
  payload: Record<string, unknown>;
  photos: Array<{role: 'evidence' | 'leader' | 'homer'; dataUrl: string; name: string}>;
  createdAt: number;
  used: boolean;
  /** 失败次数：同一个草稿最多试 3 次，避免拿着同一份数据反复打后端。 */
  attempts: number;
}

const writeDrafts = new Map<string, WriteDraft>();
const MAX_WRITE_ATTEMPTS = 3;

function putWriteDraft(draft: Omit<WriteDraft, 'createdAt' | 'used' | 'id' | 'attempts'>): WriteDraft {
  const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const full: WriteDraft = {...draft, id, createdAt: Date.now(), used: false, attempts: 0};
  writeDrafts.set(id, full);
  for (const [key, value] of writeDrafts) if (Date.now() - value.createdAt > DRAFT_TTL) writeDrafts.delete(key);
  return full;
}

function takeWriteDraft(id: string, kind?: string): WriteDraft {
  const draft = writeDrafts.get(id);
  if (!draft) throw new Error(`草稿 ${id} 不存在或已过期（有效期 10 分钟）。请重新生成。`);
  if (kind && draft.kind !== kind) throw new Error(`草稿 ${id} 是「${draft.kind}」的，不能用在「${kind}」上。`);
  if (Date.now() - draft.createdAt > DRAFT_TTL) {
    writeDrafts.delete(id);
    throw new Error('草稿已超过 10 分钟有效期，为安全起见作废了。请重新生成。');
  }
  if (draft.used) throw new Error('这张草稿已经提交成功了，不能重复使用（防重复提交）。要再办一次请重新生成。');
  if (draft.attempts >= MAX_WRITE_ATTEMPTS) {
    writeDrafts.delete(id);
    throw new Error(`这张草稿已经失败 ${MAX_WRITE_ATTEMPTS} 次，作废了。核对信息后重新生成一张。`);
  }
  return draft;
}

function putDraft(draft: Omit<Draft, 'createdAt' | 'used' | 'attempts' | 'id'>): Draft {
  const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const full: Draft = {...draft, id, createdAt: Date.now(), used: false, attempts: 0};
  drafts.set(id, full);
  // 顺手清掉过期草稿，避免内存里堆着用户的病情描述。
  for (const [key, value] of drafts) if (Date.now() - value.createdAt > DRAFT_TTL) drafts.delete(key);
  return full;
}

function takeDraft(id: string): Draft {
  const draft = drafts.get(id);
  if (!draft) throw new Error(`草稿 ${id} 不存在或已过期（有效期 10 分钟）。请重新生成一张草稿。`);
  if (Date.now() - draft.createdAt > DRAFT_TTL) {
    drafts.delete(id);
    throw new Error('草稿已超过 10 分钟有效期，为安全起见作废了。请重新生成。');
  }
  if (draft.used) throw new Error('这张草稿已经提交成功了，不能重复使用（防重复提交）。要再请一次假请重新生成草稿。');
  if (draft.attempts >= MAX_ATTEMPTS) {
    drafts.delete(id);
    throw new Error(`这张草稿已经提交失败 ${MAX_ATTEMPTS} 次，为安全起见作废了。请核对信息后重新生成一张。`);
  }
  return draft;
}

// ---------- 工具定义 ----------

const definitions = () => [
  schema(
    'xhsz_leave_types',
    '查智慧思政的请假类型字典（因病/因事/因公/假期离校/外出实习/延迟返校）。**正常请假流程不需要先调这个** —— xhsz_leave_draft 会按事由自动推断类型，推断错了确认卡上一眼能看见，让用户说一句改掉即可。只在用户问「能请哪几种假」、或自动推断连续被用户否定时才用。',
    {}
  ),

  schema(
    'xhsz_leave_draft',
    '一句话生成请假草稿并返回确认卡，**不会提交**。用户说「帮我请个假」「明天上午发烧要去医院」时**直接调这个，不要再先查字典**。' +
      '把用户原话里的时间片段整段塞进 when（如「明天上午」「后天下午」「下周一」，工具自己换算成具体日期和时分），把人话事由原样塞进 reason。' +
      '工具会自动：解析时间、按事由推断请假类型、补齐后端硬性要求的 lessons、复用对话里刚贴的图片当凭证、检查是否与已有假条时间重叠。' +
      '**不要自己编日期**：when 解析不出来会落成「明天全天」并在确认卡上标注，用户看得到。草稿 10 分钟有效。',
    {
      when: str('用户说的时间片段，原话即可：「明天上午」「后天下午三点到五点」「下周一」「11月8日全天」。工具负责换算成 YYYY-MM-DD HH:mm'),
      reason: str('请假事由，用用户自己的说法，不要扩写、不要编细节。「发烧要去医院」「家里有事要回去一趟」'),
      start_time: str('（可选，覆盖 when）开始时间 YYYY-MM-DD HH:mm。只在用户给了明确时刻格式时用'),
      end_time: str('（可选，覆盖 when）结束时间，同上'),
      kind: str('（可选）用户口头说的请假类型：「病假」「事假」「公假」「实习」。不给就按 reason 自动推断'),
      photo_path: str('（可选）凭证图片的附件路径。**一般不用传** —— 默认会自动复用对话里最近贴的图片'),
      auto_photo: bool('（可选，默认 true）自动把最近的附件图片当成凭证。设为 false 表示这次不带图'),
      mode: str('（可选）day = 按天；lesson = 按节次（工具会从「上课啦」课表自动填这几天有哪些课）；默认 auto = 半天假（上午/下午/晚上）自动按节次、整天假按天。用户说「只请上午」「请两节课」时可以显式传 lesson'),
      lessons: str('（可选）手工指定课程明细 JSON，形如 [{"date":"2026-11-08","lessons":"高等数学","whether":0,"latetime":"","remark":""}]。只有课表查不到、或用户点名要请某几门课时才用；工具查得到课表就别手填'),
      leave_school: int('（可选）1 = 外出离校，2 = 不外出。不给就按事由推断（回家/离校类 = 1，其余 = 2）', 1, 2),
      destination: str('（可选）外出目的地'),
      go_model: str('（可选）出行方式，如「高铁」「私家车」'),
      back_model: str('（可选）返校方式')
    },
    ['when', 'reason']
  ),

  schema(
    'xhsz_leave_guard',
    '请假前先算一遍影响面：这段假会漏掉哪几节课（日期+节次+课程），这些课这学期的考勤情况（已请几次假、旷几次课、迟到几次），' +
      '以及有没有「先被记旷课、补假条也改不回来」的风险。**只读，不改任何状态**。' +
      '用户问「我明天请假会缺什么课」「请这两天影响哪几门」时用；提交前想确认影响面也可以先调它。',
    {
      when: str('时间片段，原话即可：「明天上午」「下周一」「11月8日全天」'),
      start_time: str('（可选，覆盖 when）开始时间 YYYY-MM-DD HH:mm'),
      end_time: str('（可选，覆盖 when）结束时间，同上')
    }
  ),

  schema(
    'xhsz_leave_submit',
    '提交一张已经生成好的请假草稿。**必须**先给用户看过确认卡，用户明确说「提交」之后才调。commit=true 是用户的确认标记，缺了不会提交。' +
      '提交成功会自动回读单号与审批结果（短假通常是系统自动审批通过），**不需要再调 xhsz_leave_list 确认**。' +
      '后端回 501/502/503 要求补导师/家长材料时：把结果原样告诉用户、让他把那张材料贴进来，然后用**同一张草稿**带上对应路径再提交一次（草稿不作废）。不要自己造材料、不要自动重试。',
    {
      draft_id: str('草稿号，来自 xhsz_leave_draft 返回的「草稿号」'),
      confirm: bool('用户已经看过确认卡并明确同意提交。必须是 true，否则工具直接拒绝'),
      photo_path: str('（可选）提交时才拿到的凭证图路径。覆盖草稿里的照片'),
      leader_photo_path: str('（可选）导师同意书图片路径。后端回 501/503 时带'),
      homer_photo_path: str('（可选）家长知情书图片路径。后端回 502/503 时带')
    },
    ['draft_id', 'confirm']
  ),

  schema(
    'xhsz_leave_list',
    '看我的请假记录。audit 决定看哪一类：1 = 待审核，2 = 已通过，3 = 已驳回/历史。用户问「我请假批了吗」「这学期请了几次假」时用。',
    {audit: int('1 = 待审核（默认），2 = 已通过，3 = 已驳回/历史', 1, 3)},
    ['audit']
  ),

  schema(
    'xhsz_leave_detail',
    '看一条请假的完整详情（事由、起止、审批状态、销假/返校时间）。单号从 xhsz_leave_list 拿。',
    {leave_id: str('请假单号，来自 xhsz_leave_list 的「单号」列')},
    ['leave_id']
  ),

  schema(
    'xhsz_leave_close',
    '销假或返校登记。action=melt 销假（提前结束请假），action=return 返校登记（离校假到期回校）。**这两个都会改站点状态且不可撤销**，调用前必须让用户确认单号和动作。',
    {
      action: {type: 'string', enum: ['melt', 'return'], description: 'melt = 销假 / return = 返校登记'},
      leave_id: str('请假单号'),
      reason: str('返校说明（action=return 时用；melt 可省略）'),
      confirm: bool('用户已明确确认要执行这个动作')
    },
    ['action', 'leave_id', 'confirm']
  ),

  schema(
    'xhsz_leave_resubmit_draft',
    '被驳回的假条改完重新提交 —— 第一步：生成确认卡，**不提交**。用户说「我假条被驳回了」「改一下再交一次」时用。' +
      '需要先知道单号（xhsz_leave_list 或用户自己给）。工具会读原单确认它现在是不是「已驳回」状态，把原单内容一起列出来。',
    {
      leave_id: str('被驳回的请假单号'),
      reason: str('补充/修改后的请假事由（辅导员看的那段说明）。用用户原话，不要扩写、不要编细节'),
      photo_path: str('（可选）新的凭证图附件路径。不给就沿用原单里的照片'),
      leader_photo_path: str('（可选）导师同意书图片路径'),
      homer_photo_path: str('（可选）家长知情书图片路径')
    },
    ['leave_id', 'reason']
  ),

  schema(
    'xhsz_leave_resubmit',
    '提交一张「驳回重提」草稿。必须先给用户看过确认卡、用户明确说「提交」之后才调；confirm=true 是确认标记。' +
      '成功后原单会回到待审队列（站点规则：重提是覆盖原单，不新增单子）。',
    {
      draft_id: str('草稿号，来自 xhsz_leave_resubmit_draft'),
      confirm: bool('用户已经看过确认卡并明确同意提交。必须是 true')
    },
    ['draft_id', 'confirm']
  ),

  schema(
    'xhsz_workaid_opinion_draft',
    '勤工助学「月度意见」填表 —— 第一步：查本月该不该填、在哪个岗位，然后生成确认卡（不提交）。' +
      '用户说「勤工俭学的月度反馈填一下」「勤工助学要交意见」时用。工具会先读本月状态（填过没有、从哪个月开始要填）和在岗岗位。',
    {
      content: str('要提交的意见正文。用户原话即可，没有就让用户说两句'),
      month: str('（可选）月份，默认本月，格式 YYYY-MM'),
      has_suggestion: bool('（可选）是否有建议/问题要反映。默认 true（有内容时）；用户说「没意见」就传 false'),
      apply_id: str('（可选）岗位申请 id。不给就取第一个在岗岗位')
    },
    ['content']
  ),

  schema(
    'xhsz_workaid_opinion',
    '提交勤工助学月度意见。必须先给用户看过确认卡、用户明确说「提交」才调；confirm=true 是确认标记。',
    {
      draft_id: str('草稿号，来自 xhsz_workaid_opinion_draft'),
      confirm: bool('用户已经看过确认卡并明确同意提交。必须是 true')
    },
    ['draft_id', 'confirm']
  ),

  schema(
    'xhsz_workaid_withdraw_draft',
    '撤回勤工助学岗位报名 —— 第一步：列出我报名过的岗位、挑一个、生成确认卡（不提交）。' +
      '用户说「勤工助学那个岗位我不想干了」「把报名撤了」时用。**撤回会把报名记录撤掉**，不能一键恢复（要重新报名）。',
    {apply_id: str('（可选）要撤回的报名记录 id。不给就列出全部让用户选')}
  ),

  schema(
    'xhsz_workaid_withdraw',
    '执行勤工助学报名撤回。必须先给用户看过确认卡、用户明确说「撤回」才调；confirm=true 是确认标记。',
    {
      draft_id: str('草稿号，来自 xhsz_workaid_withdraw_draft'),
      confirm: bool('用户已经看过确认卡并明确同意撤回。必须是 true')
    },
    ['draft_id', 'confirm']
  ),

  schema(
    'xhsz_guide',
    '「这件事 AI 不能代填，但我告诉你去哪点、要准备什么」—— 智慧思政里那些**多步向导 / 要扫码 / 要传材料**的事务，用这个给出入口卡。' +
      'topic 可选：外宿申请、退宿申请、调寝、奖学金、卓越奖、生活思政学分、勤工助学报名、归寝签到、心理预约、基础信息采集、手册考试；不给就返回全部清单。',
    {topic: str('事项名，用户原话里的关键词就行（如「外宿」「奖学金」「学分」）')}
  ),

  schema(
    'xhsz_form_actions',
    '列出「通用写接口执行器」支持的全部接口（白名单）。用户要办的事没有专用工具时，先调这个看有没有对应接口。',
    {}
  ),

  schema(
    'xhsz_form_draft',
    '通用写接口 —— 第一步：校验字段并生成确认卡（**不提交**）。专用工具覆盖不到的学生事务都用这个：学分申报、奖学金申请、退宿、外宿建单、信息采集、紧急联系人、心理咨询预约、考勤申诉……' +
      '**只能填白名单里声明过的字段**，多传一个键会被拒（这是防模型乱造字段的闸门）。先用 xhsz_form_actions 查 action 和允许的字段。',
    {
      action: str('白名单里的接口路径，如 "/s/credit/sbSubmit"'),
      payload_json: str('字段 JSON（字符串），形如 {"studentId":"133969","hdId":"123","content":"..."}。键必须是该 action 声明过的字段'),
      note: str('（可选）给用户看的一句话说明：这次要提交什么、为什么')
    },
    ['action', 'payload_json']
  ),

  schema(
    'xhsz_form_submit',
    '提交通用写接口草稿。必须先给用户看过确认卡、用户明确说「提交」才调；confirm=true 是确认标记。',
    {
      draft_id: str('草稿号，来自 xhsz_form_draft'),
      confirm: bool('用户已经看过确认卡并明确同意提交。必须是 true')
    },
    ['draft_id', 'confirm']
  )
];

// ---------- 辅助 ----------

async function readPhoto(path: string): Promise<{dataUrl: string; name: string}> {
  const dataUrl = await readDataUrl(path);
  if (!dataUrl) throw new Error(`读不到附件 ${path}。让用户重新贴一次图。`);
  const name = path.split('/').pop() || 'evidence.png';
  return {dataUrl, name};
}

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

/**
 * 自动找「刚刚贴进来的那张图」当凭证。
 *
 * 用户通常边说「我发烧了」边贴病历 —— 那张图就在 VFS 的 attachments 里。
 * 让模型去要路径是没有意义的：它看得见图但没有路径，用户也不知道路径是什么。
 * 这里按修改时间取最新的一张（24 小时内），取不到就算了，确认卡上会写「还差照片」。
 */
async function findRecentPhoto(): Promise<{dataUrl: string; name: string; path: string; ageMinutes: number} | null> {
  try {
    const files = await listFiles('/attachments');
    const images = files.filter(file => IMAGE_RE.test(file.path));
    if (!images.length) return null;
    images.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const newest = images[0];
    const age = Date.now() - (newest.updatedAt || 0);
    // 超过 24 小时的旧图不自动当凭证 —— 容易把上次的假条照片又交一遍。
    if (age > 24 * 3600 * 1000) return null;
    return {
      dataUrl: await readDataUrl(newest.path),
      name: newest.path.split('/').pop() || 'evidence.png',
      path: newest.path,
      ageMinutes: Math.max(0, Math.round(age / 60000))
    };
  } catch {
    return null;
  }
}

/** 「病假」「事假」这种口头类型 → 字典值。 */
function kindToCategory(kind: string): string | null {
  const text = String(kind || '');
  if (/病/.test(text)) return '1';
  if (/事/.test(text)) return '2';
  if (/公/.test(text)) return '4';
  if (/实习/.test(text)) return '5';
  if (/离校|假期|回家/.test(text)) return '3';
  if (/延迟|返校/.test(text)) return '6';
  return null;
}

/** 从事由判断要不要走「外出离校」——回家/返乡/离校类才置 1。 */
function inferLeaveSchool(reason: string): 1 | 2 {
  return /(回家|返乡|离校|回老家|出省|出市|坐车|高铁|飞机|火车)/.test(String(reason || '')) ? 1 : 2;
}

/** 查已有的假条，看这段时间是不是已经请过假了。失败不影响出草稿。 */
async function findConflicts(startTime: string, endTime: string, signal: AbortSignal, excludeId?: string): Promise<string[]> {
  const out: string[] = [];
  const studentId = (() => {
    try {
      return requireStudentId();
    } catch {
      return '';
    }
  })();
  if (!studentId) return out;
  for (const audit of [1, 2] as const) {
    try {
      const rows = await listLeaves(audit, studentId, undefined, signal);
      for (const row of rows) {
        if (excludeId && String(row.id) === String(excludeId)) continue;
        if (!overlaps({startTime, endTime}, {startTime: row.startTime, endTime: row.endTime})) continue;
        const label = audit === 1 ? '待审核' : '已通过';
        out.push(`这段时间你已经有一张「${label}」的假条（单号 ${row.id}，${row.startTime ?? '?'} → ${row.endTime ?? '?'}，事由：${String(row.reason ?? '').slice(0, 30)}）`);
      }
    } catch {
      // 查失败就当没有冲突，不阻塞主流程。
    }
  }
  return [...new Set(out)];
}

// ---------- 执行 ----------

async function execute(name: string, args: Record<string, any>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();

  switch (name) {
    case 'xhsz_leave_types': {
      const types = await getLeaveTypes(signal);
      return {types};
    }

    case 'xhsz_leave_draft': {
      const studentId = requireStudentId();
      const warnings: string[] = [];

      // 1) 时间：when 优先；给了 start_time 就用显式值（模型偶尔会自己算，兜住它）。
      let span: WhenSpan;
      const whenText = typeof args.when === 'string' ? args.when.trim() : '';
      const startArg = typeof args.start_time === 'string' ? args.start_time.trim() : '';
      const endArg = typeof args.end_time === 'string' ? args.end_time.trim() : '';
      if (startArg) {
        const tail = parseWhen(endArg || '');
        span = {
          startTime: startArg,
          endTime: endArg || tail.endTime,
          days: countDays(startArg, endArg || startArg),
          label: `${startArg} → ${endArg || startArg}`,
          parsed: true
        };
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(startArg)) {
          warnings.push(`开始时间「${startArg}」不是 \`YYYY-MM-DD HH:mm\` 格式，后端可能解析不了`);
        }
      } else {
        span = parseWhen(whenText || '明天');
        if (!whenText) warnings.push('没有给时间，默认按「明天全天 08:00-18:00」出草稿');
        else if (!span.parsed) warnings.push(`没听懂「${whenText}」是哪天，按明天全天出草稿`);
      }

      // 2) 请假类型：口头类型 > 事由推断 > 字典值直传。
      const reason = String(args.reason || '').trim();
      if (!reason) throw new Error('事由是必填的。用户的原话是什么就填什么，比如「发烧要去医院」。');
      const kindCategory = kindToCategory(String(args.kind || ''));
      const guessed = inferCategory(reason);
      const category = String(args.category || kindCategory || guessed.category);
      let label = categoryLabel(category);
      let categoryInferred = !args.category && !kindCategory;
      try {
        const types = await getLeaveTypes(signal);
        const hit = types.find(item => String(item.dictValue) === category);
        if (hit) {
          label = String(hit.dictLabel);
          // 字典的 status：'0' = 启用，'1' = 停用（实测：延迟返校 6 是 '1'）。
          if (String(hit.status) !== '0') warnings.push(`「${hit.dictLabel}」这个类型当前是停用状态，后端可能拒收`);
        } else {
          warnings.push(`字典里没有 category=${category}，可能提交会被拒`);
        }
      } catch {
        // 字典取不到不影响出草稿，只是确认卡上显示兜底名。
      }

      // 3) lessons：后端硬性要求（type=1 也要传）。能查到课表时按节次自动填，
      //    查不到就按天请假 + 每天补一条空记录 —— 用户什么都不用说。
      const modeArg = String(args.mode || '').trim();
      let type = (modeArg === 'lesson' ? 2 : modeArg === 'day' ? 1 : 1) as 1 | 2;
      const lessonsRaw = typeof args.lessons === 'string' ? args.lessons.trim() : '';
      let lessons: Draft['lessons'];
      let lessonSummary: string | undefined;

      if (lessonsRaw) {
        try {
          lessons = JSON.parse(lessonsRaw);
        } catch {
          throw new Error('lessons 不是合法 JSON。按节次请假要传数组，如 [{"date":"2026-11-08","lessons":"高等数学","whether":0}]');
        }
        type = 2;
      } else if (modeArg !== 'day') {
        // 半天假（上午/下午/晚上）才值得按节次请；整天请假按天走就够了。
        const partial = isPartialDay(span.startTime, span.endTime);
        const wantsLesson = modeArg === 'lesson' || partial;
        if (wantsLesson) {
          try {
            const snapshot = await loadTimetable();
            const built = lessonsFromTimetable(snapshot, span.startTime, span.endTime);
            if (built.hitCount > 0) {
              type = 2;
              lessons = built.rows;
              lessonSummary = built.summary;
            } else {
              lessonSummary = `${built.summary} —— 按天请假（不用选课）`;
              if (modeArg === 'lesson') warnings.push('这段时间课表里没有课，已退回按天请假');
            }
          } catch (error) {
            const reason = !hasBackgroundBridge()
              ? '需要在浏览器扩展形态下才能读到课表'
              : (error as Error).message || '未知原因';
            lessonSummary = `课表查不到（${reason}），按天请假`;
            if (modeArg === 'lesson') warnings.push(`按节次请假失败：${reason}`);
          }
        }
      }

      if (type === 2 && (!lessons || !lessons.length)) {
        throw new Error('按节次请假必须有课程明细，但这段时间课表里没查到课。改成按天请假（mode=day），或者把课程名直接给 lessons。');
      }
      if (!lessons || !lessons.length) {
        lessons = buildDefaultLessons(span.startTime, span.endTime);
      }

      // 4) 照片：显式路径 > 自动复用最近的附件。
      const photos: Draft['photos'] = [];
      let photoSource = '';
      const explicit = typeof args.photo_path === 'string' ? args.photo_path.trim() : '';
      if (explicit) {
        photos.push({role: 'evidence', ...(await readPhoto(explicit))});
        photoSource = `指定附件 ${explicit}`;
      } else if (args.auto_photo !== false) {
        const found = await findRecentPhoto();
        if (found) {
          photos.push({role: 'evidence', dataUrl: found.dataUrl, name: found.name});
          photoSource = `自动复用 ${found.ageMinutes} 分钟前贴的图（${found.path}）`;
        }
      }
      if (!photos.length) {
        warnings.push('还没有凭证照片 —— 后端第一道校验就是照片，没图会回「请上传照片」。把你的病历/证明图贴进来，我下一轮直接提交');
      }

      // 5) 时间重叠检查。
      const conflicts = await findConflicts(span.startTime, span.endTime, signal);
      warnings.push(...conflicts);

      const leaveSchool = (Number(args.leave_school) || inferLeaveSchool(reason)) as 1 | 2;
      // 提交给站点的 lessons 只留站点认的五个键。展示用的 lesson（节次）在这里剥掉，
      // 否则会跟着 JSON 一起进后端。
      const payloadLessons = (lessons || []).map(item => ({
        date: item.date,
        lessons: item.lessons,
        whether: 0,
        latetime: '',
        remark: ''
      }));
      const form: LeaveForm = {
        studentId,
        type,
        category,
        startTime: span.startTime,
        endTime: span.endTime,
        sky: countDays(span.startTime, span.endTime, lessons?.length),
        reason,
        img: '',
        isLesson: type === 2 ? 1 : 2,
        leaveSchool,
        inCity: 1,
        ...(args.destination ? {destination: String(args.destination)} : {}),
        ...(args.go_model ? {goModel: String(args.go_model)} : {}),
        ...(args.back_model ? {backModel: String(args.back_model)} : {}),
        lessons: JSON.stringify(payloadLessons)
      };

      const draft = putDraft({
        form,
        categoryLabel: `${label}（${category}）${categoryInferred ? ' · 按事由推断' : ''}`,
        lessons,
        photos,
        spanLabel: span.label,
        lessonSummary,
        warnings
      });
      const view: DraftView = {
        id: draft.id,
        form,
        categoryLabel: draft.categoryLabel,
        lessons,
        photoCount: photos.length,
        photoSource,
        spanLabel: span.label,
        lessonSummary,
        warnings,
        ttlSeconds: DRAFT_TTL / 1000
      };
      return {draftId: draft.id, view};
    }

    case 'xhsz_leave_guard': {
      const startArg = typeof args.start_time === 'string' ? args.start_time.trim() : '';
      const endArg = typeof args.end_time === 'string' ? args.end_time.trim() : '';
      const whenText = typeof args.when === 'string' ? args.when.trim() : '';
      const span = startArg
        ? {startTime: startArg, endTime: endArg || startArg, label: `${startArg} → ${endArg || startArg}`, days: countDays(startArg, endArg || startArg), parsed: true}
        : parseWhen(whenText || '明天');
      const snapshot = await loadTimetable();
      const attendance = await loadAttendance(snapshot.year, snapshot.semester);
      const audit = auditSpan(snapshot, attendance, span.startTime, span.endTime);
      return {
        span,
        audit,
        snapshot: {year: snapshot.year, semester: snapshot.semester, week: snapshot.week, courses: attendance.length}
      };
    }

    case 'xhsz_leave_submit': {
      if (args.confirm !== true) {
        throw new Error('没有用户确认，不提交。先把确认卡给用户看，用户说「提交」之后再用 confirm=true 调一次。');
      }
      const draft = takeDraft(String(args.draft_id || ''));
      const studentId = requireStudentId();
      draft.form.studentId = studentId;

      // 照片是在提交时才上传的：草稿阶段只存 dataUrl，不上服务端。
      const extra: Array<{role: 'leader' | 'homer'; path: string}> = [];
      if (typeof args.leader_photo_path === 'string' && args.leader_photo_path.trim()) extra.push({role: 'leader', path: args.leader_photo_path.trim()});
      if (typeof args.homer_photo_path === 'string' && args.homer_photo_path.trim()) extra.push({role: 'homer', path: args.homer_photo_path.trim()});

      const uploaded: string[] = [];
      // 提交时才补的凭证图覆盖草稿里那张（用户可能先说话、后贴图）。
      const latePhoto = typeof args.photo_path === 'string' ? args.photo_path.trim() : '';
      if (latePhoto) {
        const photo = await readPhoto(latePhoto);
        uploaded.push(await uploadImage(photo.dataUrl, photo.name, signal));
      }
      for (const photo of draft.photos) {
        signal.throwIfAborted();
        if (latePhoto) break;
        uploaded.push(await uploadImage(photo.dataUrl, photo.name, signal));
      }
      for (const item of extra) {
        signal.throwIfAborted();
        const photo = await readPhoto(item.path);
        const fileName = await uploadImage(photo.dataUrl, photo.name, signal);
        if (item.role === 'leader') draft.form.leaderImg = fileName;
        else draft.form.homerImg = fileName;
        uploaded.push(fileName);
      }
      if (uploaded.length) draft.form.img = uploaded.join(',');

      const result: LeaveSubmitResult = await submitLeave(draft.form, signal);

      if (result.code === 202) {
        // 只有真成功了才消耗草稿：失败/要补材料时草稿必须还能用。
        draft.used = true;
        // 回读单号。短假会被系统**自动审批通过**（实测：审批人栏写「通过」，isAutoAudit=1），
        // 直接进「已通过」队列，待审核里根本查不到。所以两个口径都查一遍。
        const day = (draft.form.startTime.match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
        for (const audit of [1, 2] as const) {
          try {
            const rows = await listLeaves(audit, studentId, undefined, signal);
            const match = rows.find(row => (day ? String(row.startTime || '').includes(day) : false)) || (rows.length ? rows[0] : null);
            if (match) return {result, leaveId: match.id, audit};
          } catch {
            // 回读失败不影响「提交成功」这个事实。
          }
        }
        return {result};
      }

      if (result.need) {
        // 缺材料：草稿保留，下次带上材料用同一个 draft_id 再提交。
        // 不计入 attempts —— 这是规则要求，不是用户输错了。
        draft.attempts = Math.max(0, draft.attempts - 1);
      } else {
        draft.attempts += 1;
      }
      // 只要没成功、也没被判废，草稿就还能用 —— 别让模型以为要重出一张。
      return {result, draftStillValid: !draft.used && draft.attempts < MAX_ATTEMPTS};
    }

    case 'xhsz_leave_list': {
      const studentId = requireStudentId();
      const audit = (Number(args.audit) || 1) as 1 | 2 | 3;
      const rows = await listLeaves(audit, studentId, undefined, signal);
      return {audit, rows};
    }

    case 'xhsz_leave_detail': {
      const studentId = requireStudentId();
      const detail = await leaveDetail(String(args.leave_id || ''), studentId, signal);
      return {detail};
    }

    case 'xhsz_leave_close': {
      if (args.confirm !== true) {
        throw new Error('没有用户确认，不执行。销假/返校都会改站点状态且不可撤销，必须让用户明确同意。');
      }
      const action = String(args.action || '');
      const leaveId = String(args.leave_id || '');
      if (action === 'melt') {
        const envelope = await meltLeave(leaveId, signal);
        return {action, envelope};
      }
      if (action === 'return') {
        const envelope = await returnLeave(leaveId, String(args.reason || ''), signal);
        return {action, envelope};
      }
      throw new Error(`未知动作 ${action}，只能是 melt 或 return。`);
    }

    case 'xhsz_leave_resubmit_draft': {
      const studentId = requireStudentId();
      const leaveId = String(args.leave_id || '').trim();
      if (!leaveId) throw new Error('要给单号。从 xhsz_leave_list 拿，或者让用户报单号。');
      const reason = String(args.reason || '').trim();
      if (!reason) throw new Error('要一段新的说明（辅导员看的就是这段）。用户怎么说就怎么填，别扩写。');

      const detail = await leaveDetail(leaveId, studentId, signal);
      const status = Number(detail?.status);
      const warnings: string[] = [];
      // 3 = 已驳回。站点没有别的入口能重提一张「已通过」的单子，先把它挑明。
      if (status && status !== 3) {
        warnings.push(`这张单子当前状态是 ${status}（不是「已驳回」=3）。重提接口只对被驳回的单子有意义 —— 如果你确定要试，我可以发，但大概率被后端拒。`);
      }

      const original = {
        reason: String(detail?.reason ?? ''),
        startTime: String(detail?.startTime ?? ''),
        endTime: String(detail?.endTime ?? ''),
        type: detail?.type,
        category: detail?.category,
        img: String(detail?.img ?? '')
      };

      const photos: WriteDraft['photos'] = [];
      const explicit = typeof args.photo_path === 'string' ? args.photo_path.trim() : '';
      if (explicit) photos.push({role: 'evidence', ...(await readPhoto(explicit))});
      if (typeof args.leader_photo_path === 'string' && args.leader_photo_path.trim()) {
        photos.push({role: 'leader', ...(await readPhoto(args.leader_photo_path.trim()))});
      }
      if (typeof args.homer_photo_path === 'string' && args.homer_photo_path.trim()) {
        photos.push({role: 'homer', ...(await readPhoto(args.homer_photo_path.trim()))});
      }
      if (!photos.length && !original.img) {
        warnings.push('原单没有照片、这次也没给新图 —— 后端第一道校验就是照片，很可能回「请上传照片」。');
      }

      const preview = [
        `### 驳回重提确认单`,
        '',
        '| 项 | 内容 |',
        '|---|---|',
        `| 单号 | ${leaveId}（当前状态 ${status ? status : '站点未返回'}） |`,
        `| 原事由 | ${original.reason || '—'} |`,
        `| 原时间 | ${original.startTime || '?'} → ${original.endTime || '?'} |`,
        `| 新说明 | ${reason} |`,
        `| 照片 | ${photos.length ? `${photos.length} 张（新上传）` : original.img ? '沿用原单的图' : '**没有**'} |`
      ].join('\n');

      const draft = putWriteDraft({
        kind: 'leave-resubmit',
        title: '驳回重提',
        preview,
        payload: {
          leaveId,
          reason,
          // 原单的字段原样带回去：站点前端就是这么重提的（覆盖，不是新建）。
          type: original.type,
          category: original.category,
          originalImg: original.img
        },
        photos
      });

      return {draftId: draft.id, view: {id: draft.id, preview, warnings, original, reason, ttlSeconds: DRAFT_TTL / 1000}};
    }

    case 'xhsz_leave_resubmit': {
      if (args.confirm !== true) {
        throw new Error('没有用户确认，不提交。先把确认卡给用户看，用户说「提交」之后再用 confirm=true 调一次。');
      }
      const draft = takeWriteDraft(String(args.draft_id || ''), 'leave-resubmit');
      const studentId = requireStudentId();

      const uploaded: string[] = [];
      let leaderImg: string | undefined;
      let homerImg: string | undefined;
      for (const photo of draft.photos) {
        signal.throwIfAborted();
        const fileName = await uploadImage(photo.dataUrl, photo.name, signal);
        uploaded.push(fileName);
        if (photo.role === 'leader') leaderImg = fileName;
        else if (photo.role === 'homer') homerImg = fileName;
      }
      const evidence = uploaded.filter((_, index) => draft.photos[index]?.role === 'evidence');
      const img = evidence.length ? evidence.join(',') : String(draft.payload.originalImg || '');

      const envelope = await resubmitLeave({
        studentId,
        leaveId: String(draft.payload.leaveId),
        reason: String(draft.payload.reason),
        ...(draft.payload.type !== undefined && draft.payload.type !== null ? {type: String(draft.payload.type)} : {}),
        ...(img ? {img} : {}),
        ...(leaderImg ? {leaderImg} : {}),
        ...(homerImg ? {homerImg} : {})
      }, signal);

      if (isOk(envelope.code)) draft.used = true;
      return {envelope, code: envelope.code, msg: envelope.msg};
    }

    case 'xhsz_workaid_opinion_draft': {
      const studentId = requireStudentId();
      const content = String(args.content || '').trim();
      if (!content) throw new Error('意见正文是空的。让用户说两句，哪怕「本月无问题」也行。');
      const monthKey = String(args.month || '').trim() || new Date().toISOString().slice(0, 7);

      const status = await workAidOpinionStatus(studentId, monthKey, signal);
      const warnings: string[] = [];
      if (status?.done === true || status?.done === 1) warnings.push(`站点显示 ${monthKey} 的意见已经填过了，再提交可能会覆盖或报错`);
      if (status?.goLiveMonth && monthKey < String(status.goLiveMonth)) {
        warnings.push(`这个月（${monthKey}）还没到需要填的时候，站点给的起始月份是 ${status.goLiveMonth}`);
      }

      const jobs = await listWorkAidJobs(studentId, signal);
      const target = args.apply_id
        ? jobs.find(job => String(job.id) === String(args.apply_id))
        : jobs[0];
      if (!target) throw new Error('没有查到在岗的勤工助学岗位 —— 没岗位就没有月度意见可填。');

      const hasSuggestion = args.has_suggestion === false ? false : true;
      const jobName = String((target as any).jobName || (target as any).jobTitle || (target as any).name || '在岗岗位');
      const preview = [
        '### 勤工助学月度意见（确认单）',
        '',
        '| 项 | 内容 |',
        '|---|---|',
        `| 月份 | ${monthKey} |`,
        `| 岗位 | ${jobName}（applyId ${target.id}） |`,
        `| 本月工时 | ${status?.monthHours ?? '站点未返回'} |`,
        `| 是否有建议 | ${hasSuggestion ? '有' : '无'} |`,
        `| 意见正文 | ${content} |`
      ].join('\n');

      const draft = putWriteDraft({
        kind: 'workaid-opinion',
        title: '勤工助学月度意见',
        preview,
        payload: {studentId, applyId: String(target.id), monthKey, hasSuggestion, content},
        photos: []
      });
      return {draftId: draft.id, view: {id: draft.id, preview, warnings, monthKey, jobName, ttlSeconds: DRAFT_TTL / 1000}};
    }

    case 'xhsz_workaid_opinion': {
      if (args.confirm !== true) {
        throw new Error('没有用户确认，不提交。先给用户看确认卡，用户说「提交」之后再用 confirm=true 调一次。');
      }
      const draft = takeWriteDraft(String(args.draft_id || ''), 'workaid-opinion');
      const envelope = await submitWorkAidOpinion({
        studentId: String(draft.payload.studentId),
        applyId: String(draft.payload.applyId),
        monthKey: String(draft.payload.monthKey),
        hasSuggestion: Boolean(draft.payload.hasSuggestion),
        content: String(draft.payload.content)
      }, signal);
      if (isOk(envelope.code)) draft.used = true;
      return {envelope, code: envelope.code, msg: envelope.msg};
    }

    case 'xhsz_workaid_withdraw_draft': {
      const studentId = requireStudentId();
      const applies = await listWorkAidApplies(studentId, signal);
      if (!applies.length) throw new Error('没有查到勤工助学报名记录 —— 没报名就没有可撤的。');

      if (!args.apply_id) {
        // 没指定就列出来让用户选，不替他挑。
        const lines = ['### 我的勤工助学报名记录', '', '| 报名 id | 岗位 | 状态 |', '|---|---|---|'];
        for (const item of applies.slice(0, 20)) {
          const jobName = String((item as any).jobName || (item as any).jobTitle || (item as any).name || '—');
          const status = String((item as any).status ?? (item as any).applyStatus ?? '—');
          lines.push(`| ${item.id} | ${jobName} | ${status} |`);
        }
        lines.push('', '要撤哪一条请把「报名 id」告诉我（`apply_id`），我再出一张确认卡。');
        return {needsChoice: true, applyIds: applies.map(item => item.id), candidates: applies, render: lines.join('\n')};
      }

      const target = applies.find(item => String(item.id) === String(args.apply_id));
      if (!target) throw new Error(`报名记录里没有 id=${args.apply_id}。先用不带 apply_id 的方式列一遍。`);

      const jobName = String((target as any).jobName || (target as any).jobTitle || (target as any).name || '—');
      const preview = [
        '### 撤回勤工助学报名（确认单）',
        '',
        '| 项 | 内容 |',
        '|---|---|',
        `| 报名 id | ${target.id} |`,
        `| 岗位 | ${jobName} |`,
        `| 当前状态 | ${(target as any).status ?? (target as any).applyStatus ?? '站点未返回'} |`
      ].join('\n');

      const draft = putWriteDraft({
        kind: 'workaid-withdraw',
        title: '勤工助学撤回报名',
        preview,
        payload: {studentId, applyId: String(target.id), jobName},
        photos: []
      });
      return {
        draftId: draft.id,
        view: {
          id: draft.id,
          preview,
          warnings: ['撤回后这条报名记录就没了，要重新报名得再走一遍申请（可能要重新审核）。'],
          ttlSeconds: DRAFT_TTL / 1000
        }
      };
    }

    case 'xhsz_workaid_withdraw': {
      if (args.confirm !== true) {
        throw new Error('没有用户确认，不撤回。先给用户看确认卡，用户说「撤回」之后再用 confirm=true 调一次。');
      }
      const draft = takeWriteDraft(String(args.draft_id || ''), 'workaid-withdraw');
      const envelope = await withdrawWorkAidApply(String(draft.payload.applyId), String(draft.payload.studentId), signal);
      if (isOk(envelope.code)) draft.used = true;
      return {envelope, code: envelope.code, msg: envelope.msg};
    }

    case 'xhsz_guide':
      return {topics: findGuide(String(args.topic || ''))};

    case 'xhsz_form_actions':
      return {actions: listFormActions()};

    case 'xhsz_form_draft': {
      const studentId = requireStudentId();
      const spec = findFormAction(String(args.action || ''));
      if (!spec) {
        throw new Error(
          `「${args.action}」不在白名单里。先说清楚要办什么，我用 xhsz_form_actions 查一下有没有对应的接口 —— ` +
            '不能凭空拼一个路径发出去。'
        );
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(args.payload_json || '{}'));
      } catch {
        throw new Error('payload_json 不是合法 JSON。形如 {"studentId":"133969","reason":"..."}');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('payload_json 必须是一个对象。');
      }
      // 站点所有学生端接口都认 studentId，缺了就是「查不到人」，这里替模型补上。
      if (spec.fields.includes('studentId') && !payload.studentId) payload.studentId = studentId;

      const check = checkPayload(spec, payload);
      if (!check.ok) {
        throw new Error(
          `字段越界：${check.unexpected.join('、')} 不是「${spec.label}」声明的字段。` +
            `允许的字段是：${spec.fields.join('、') || '（该接口按站点表单原样提交，暂不开放随意填写）'}。`
        );
      }

      const rows = Object.entries(payload).map(([key, value]) => `| ${key} | ${String(value).slice(0, 80)} |`);
      const preview = [
        `### ${spec.label}（确认单）`,
        '',
        `接口：\`${spec.action}\``,
        ...(args.note ? ['', `说明：${String(args.note)}`] : []),
        '',
        '| 字段 | 值 |',
        '|---|---|',
        ...rows
      ].join('\n');

      const draft = putWriteDraft({
        kind: 'form',
        title: spec.label,
        preview,
        payload: {action: spec.action, payload},
        photos: []
      });
      return {
        draftId: draft.id,
        view: {
          id: draft.id,
          title: spec.label,
          preview,
          warnings: [
            spec.danger,
            ...(check.empty.length ? [`这些字段是空的：${check.empty.join('、')} —— 确认一下是不是该填`] : [])
          ],
          ttlSeconds: DRAFT_TTL / 1000
        }
      };
    }

    case 'xhsz_form_submit': {
      if (args.confirm !== true) {
        throw new Error('没有用户确认，不提交。先给用户看确认卡，用户说「提交」之后再用 confirm=true 调一次。');
      }
      const draft = takeWriteDraft(String(args.draft_id || ''), 'form');
      const envelope = await postAction(String(draft.payload.action), draft.payload.payload as Record<string, unknown>, signal);
      if (isOk(envelope.code)) draft.used = true;
      else draft.attempts += 1;
      return {envelope, code: envelope.code, msg: envelope.msg, action: draft.payload.action, attemptsLeft: Math.max(0, MAX_WRITE_ATTEMPTS - draft.attempts)};
    }

    default:
      throw new Error(`未知智慧思政工具：${name}`);
  }
}

// ---------- 渲染 ----------

function render(name: string, value: any): string {
  switch (name) {
    case 'xhsz_leave_types':
      return renderLeaveTypes(value?.types || []);
    case 'xhsz_leave_draft':
      return renderDraft(value.view);
    case 'xhsz_leave_guard':
      return renderGuard(value);
    case 'xhsz_leave_submit':
      return renderSubmit(value.result, value.leaveId, value.audit, value.draftStillValid);
    case 'xhsz_leave_list':
      return renderLeaveList(value.rows || [], value.audit);
    case 'xhsz_leave_detail':
      return renderLeaveDetail(value.detail);
    case 'xhsz_leave_close':
      return renderClose(value.action, value.envelope || {});
    case 'xhsz_leave_resubmit_draft':
      return renderResubmitDraft(value.view);
    case 'xhsz_leave_resubmit':
      return renderResubmitResult(value);
    case 'xhsz_workaid_opinion_draft':
      return renderWriteDraft('勤工助学月度意见', value.view);
    case 'xhsz_workaid_opinion':
      return renderWriteResult('勤工助学月度意见', value);
    case 'xhsz_workaid_withdraw_draft':
      return value.render ? value.render : renderWriteDraft('勤工助学撤回报名', value.view);
    case 'xhsz_workaid_withdraw':
      return renderWriteResult('勤工助学撤回报名', value);
    case 'xhsz_guide':
      return renderGuide(value.topics || []);
    case 'xhsz_form_actions':
      return renderFormActions();
    case 'xhsz_form_draft':
      return renderWriteDraft(value.view?.title || '这条操作', value.view);
    case 'xhsz_form_submit': {
      const label = findFormAction(String(value.action || ''))?.label || String(value.action || '');
      return renderWriteResult(label, value);
    }
    default:
      return JSON.stringify(value).slice(0, 4000);
  }
}

// ---------- 注册 ----------

export const xhszSeries: SeriesModule = {
  id: 'xhsz',
  names: XHSZ_TOOL_NAMES,
  definitions,
  execute,
  render,
  riskOf(tool) {
    switch (tool) {
      case 'xhsz_leave_submit':
      case 'xhsz_leave_close':
      case 'xhsz_leave_resubmit':
      case 'xhsz_workaid_opinion':
      case 'xhsz_workaid_withdraw':
      case 'xhsz_form_submit':
        return 'act';
      case 'xhsz_leave_draft':
      case 'xhsz_leave_resubmit_draft':
      case 'xhsz_workaid_opinion_draft':
      case 'xhsz_workaid_withdraw_draft':
      case 'xhsz_form_draft':
        // 草稿不碰服务端，但要往表单里填东西，按 fill 走（会要求一次「一起填写」授权）。
        return 'fill';
      default:
        return 'read';
    }
  }
};

registerSeries(xhszSeries);
