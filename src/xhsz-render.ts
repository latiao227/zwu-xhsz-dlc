// 智慧思政渲染层：把领域层的结果排成给模型看的文本。
//
// 规矩跟主仓其它系列一致：**归一发生在 api 层，渲染层只负责排版**。
// 这里不判断业务状态，只把状态翻译成人话。
//
// 特别说明（确认卡）：这张卡是用户唯一一次「看清要发出去什么」的机会，
// 所以它必须**一屏看完、字段齐全、缺什么直接说、下一步动作只有一句话**。
import type {LeaveForm, LeaveRow, LeaveSubmitResult, LeaveType} from './xhsz-api';

const LEAVE_TYPE_LABEL: Record<number, string> = {1: '按天请假', 2: '按节次请假'};
const OUTING_LABEL: Record<number, string> = {1: '外出（离校）', 2: '不外出'};
const AUDIT_LABEL: Record<number, string> = {1: '待审核', 2: '已通过', 3: '已驳回 / 历史'};

/** 请假类型字典表。 */
export function renderLeaveTypes(types: LeaveType[]): string {
  if (!types.length) return '智慧思政的请假类型字典是空的 —— 可能是账号没有请假权限，也可能是字典被后台关了。';
  const rows = types.map(t => `| ${t.dictValue} | ${t.dictLabel} | ${t.status === '0' ? '启用' : '停用'} |`);
  return ['| category | 名称 | 状态 |', '|---|---|---|', ...rows].join('\n') +
    '\n\n填假条时 `category` 用第一列的值（是字典值，不是名称）。正常请假不用先查这张表 —— 草稿会按事由自动推断。';
}

export interface DraftView {
  id: string;
  form: LeaveForm;
  categoryLabel: string;
  lessons?: Array<{date: string; lessons: string; remark?: string; lesson?: string}>;
  photoCount: number;
  /** 照片从哪来（自动复用 / 指定附件 / 还没有）。 */
  photoSource?: string;
  /** 解析出来的人话时间（「明天上午」→ 2026-11-08 08:00-12:00）。 */
  spanLabel?: string;
  /** 课表命中情况。 */
  lessonSummary?: string;
  /** 出草稿时发现的风险，直说。 */
  warnings?: string[];
  ttlSeconds: number;
}

/**
 * 草稿格式化：把内部草稿对象排成确认卡。
 *
 * 设计目标：用户扫一眼就能判断「发出去的到底是不是我想的那个」。
 * 所以时间用人话复述、缺项单独一栏、末尾只留一个动作。
 */
export function renderDraft(draft: DraftView): string {
  const f = draft.form;
  const lines: string[] = ['### 请假确认单', '', '| 项 | 内容 |', '|---|---|'];
  lines.push(`| 请假类型 | ${draft.categoryLabel || f.category} |`);
  lines.push(`| 时间 | ${draft.spanLabel || `${f.startTime} → ${f.endTime}`} |`);
  lines.push(`| 天数 | ${f.sky} 天（${LEAVE_TYPE_LABEL[f.type] ?? f.type}） |`);
  lines.push(`| 事由 | ${f.reason} |`);
  lines.push(`| 是否外出 | ${OUTING_LABEL[f.leaveSchool ?? 2] ?? f.leaveSchool}${f.destination ? ` → ${f.destination}` : ''}${f.goModel ? `（${f.goModel}）` : ''} |`);

  if (draft.lessons && draft.lessons.length) {
    const named = draft.lessons.filter(item => item.lessons);
    lines.push(
      `| 涉及课程 | ${
        named.length
          ? named.map(item => `${item.date} ${item.lessons}${item.lesson ? `（${item.lesson} 节）` : ''}`).join('；')
          : '按天请假，未指定具体课程（后端要求的空记录已自动补齐）'
      } |`
    );
  }
  if (draft.lessonSummary) lines.push(`| 课表 | ${draft.lessonSummary} |`);
  lines.push(`| 凭证照片 | ${draft.photoCount ? `${draft.photoCount} 张${draft.photoSource ? `（${draft.photoSource}）` : ''}` : '**还没有** |'}`);

  lines.push('');
  const warnings = draft.warnings || [];
  if (warnings.length) {
    lines.push('**需要注意：**');
    for (const item of warnings) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push(`草稿号 \`${draft.id}\`，${Math.round(draft.ttlSeconds / 60)} 分钟内有效。`);
  lines.push('');
  if (!draft.photoCount) {
    lines.push('**下一步**：把病历/证明照片贴进来，然后回复「提交」——我会带上这张图一起发。');
  } else {
    lines.push('**下一步**：没问题就回复「提交」，我立刻发出去并回读单号。');
  }
  lines.push('要改哪一项直接说（「改成下午」「改成事假」「不外出了」），我重新出一张，不用重说事由。');
  return lines.join('\n');
}

/** 提交结果。`audit` 是回读时命中的口径：1 = 还在待审，2 = 已（自动）通过。 */
export function renderSubmit(result: LeaveSubmitResult, id?: string | number, audit?: 1 | 2 | 3, draftStillValid?: boolean): string {
  if (result.code === 202) {
    const lines = ['**提交成功**（后端回 202）。', ''];
    lines.push(id ? `单号：\`${id}\`` : '单号：这次没回读到，用 xhsz_leave_list 的「待审核」再看一次。');
    if (id && audit === 2) {
      lines.push('');
      lines.push('这条**已经审批通过了** —— 短假走系统自动审批（审批记录里 isAutoAudit=1），不用等辅导员。');
    } else if (id) {
      lines.push('');
      lines.push('现在在「待审核」里等辅导员处理。要查进度就说「查我的请假」。');
    }
    lines.push('');
    lines.push('到此结束，**不需要再调任何工具确认**。');
    return lines.join('\n');
  }
  if (result.need) {
    const needText = result.need === 'leader' ? '导师同意书' : result.need === 'homer' ? '家长知情书' : '导师同意书 + 家长知情书';
    return [
      `**这次没提交成功**，后端要求补材料：${needText}（code ${result.code}）。`,
      '',
      '这是站点规则，不是出错：离校类/长假类请假要额外凭证。',
      draftStillValid
        ? `**草稿还在**（没作废，也没重新计时）—— 把${needText}的照片贴进来，我直接用同一张草稿再提交一次，不用重说事由。`
        : `请把${needText}的照片贴进对话框，我再提交一次 —— 这次会带上它。`,
      '',
      '注意：补材料会**重新提交整张假条**，原申请不会留在待审队列里（前端源码就是这么做的）。',
    ].join('\n');
  }
  return [
    `提交失败（code ${result.code}）：${result.msg || '后端没给原因'}。`,
    '',
    '草稿还在，可以直接改完再提交；同一个草稿最多试 3 次，超了要重新生成。',
  ].join('\n');
}

/** 请假列表。 */
export function renderLeaveList(rows: LeaveRow[], audit: 1 | 2 | 3): string {
  if (!rows.length) return `当前账号「${AUDIT_LABEL[audit]}」的请假记录为空。`;
  const lines = ['| # | 单号 | 起止 | 天数 | 事由 | 状态 |', '|---|---|---|---|---|---|'];
  rows.slice(0, 30).forEach((r, i) => {
    const span = `${r.startTime ?? '?'} → ${r.endTime ?? '?'}`;
    lines.push(`| ${i + 1} | ${r.id} | ${span} | ${estimateDays(r)} | ${(r.reason ?? '').slice(0, 40)} | ${statusText(r, audit)} |`);
  });
  if (rows.length > 30) lines.push(`\n（只显示前 30 条，共 ${rows.length} 条）`);
  return lines.join('\n');
}

function estimateDays(row: LeaveRow): string {
  const direct = row.sky ?? row.days ?? row.leaveDays;
  if (direct !== undefined && direct !== null && direct !== '') return String(direct);
  return '—';
}

function statusText(row: LeaveRow, audit?: 1 | 2 | 3): string {
  const map: Record<string, string> = {
    '1': '待审核', '2': '已通过', '3': '已驳回', '4': '已销假', '5': '已撤回'
  };
  const value = row.status ?? row.auditStatus ?? '';
  const text = map[String(value)];
  if (text) return text;
  // audit=3 列表里站点不返回 status，全空 —— 别显示成「—」，按口径说人话。
  if (audit === 3) return '历史/驳回';
  if (audit === 2) return '已通过';
  if (audit === 1) return '待审核';
  return String(value || '—');
}

/** 请假详情。 */
export function renderLeaveDetail(detail: any): string {
  if (!detail || typeof detail !== 'object') return '没取到这条请假的详情。';
  const keep = ['id', 'reason', 'startTime', 'endTime', 'type', 'category', 'status', 'createTime', 'meltTime', 'returnTime'];
  const lines = ['### 请假详情', ''];
  for (const key of keep) {
    if (detail[key] !== undefined && detail[key] !== null && detail[key] !== '') lines.push(`- ${key}：${detail[key]}`);
  }
  const extra = Object.keys(detail).filter(k => !keep.includes(k) && typeof detail[k] !== 'object');
  if (extra.length) lines.push('', `其它字段：${extra.slice(0, 20).join(', ')}`);
  return lines.join('\n');
}

/**
 * 请假影响面（xhsz_leave_guard）。
 *
 * 必须把「考勤只有学期总计、没有按日期明细」这条边界写出来 ——
 * 否则模型会把它当成「这次假已经记进考勤了」。
 */
export function renderGuard(value: {
  span: {label: string};
  audit: {rows: Array<{date: string; lesson: string; course: string; teachers: string; room: string; leaveCount: number; truantCount: number; lateCount: number; verdict: string}>; summary: string; flags: string[]; lessonCount: number};
  snapshot: {year: string; semester: string; week: string};
}): string {
  const {span, audit, snapshot} = value;
  const lines = ['### 请假影响面', '', `时间：${span.label}`, `课表：${snapshot.year} 第${snapshot.semester}学期 · 第${snapshot.week}周`, ''];
  lines.push(audit.summary);

  if (audit.rows.length) {
    lines.push('', '| 日期 | 节次 | 课程 | 教师 | 本学期已请假 | 考勤结论 |', '|---|---|---|---|---|---|');
    for (const row of audit.rows) {
      lines.push(`| ${row.date.slice(5)} | ${row.lesson} | ${row.course} | ${row.teachers || '—'} | ${row.leaveCount} 次 | ${row.verdict} |`);
    }
  }

  if (audit.flags.length) {
    lines.push('', '**要注意：**');
    for (const flag of audit.flags) lines.push(`- ${flag}`);
  }

  lines.push(
    '',
    '**口径说明**：考勤数字是「这门课整学期的累计」，站点不提供按日期明细 —— 所以这里答不了「这一节课当天算不算请假」，' +
      '只能答「这门课你已经请过几次、旷过几次」。补假条之后考勤通常不会立刻同步，隔一天再查才准。'
  );
  return lines.join('\n');
}

/** 驳回重提：确认卡。 */
export function renderResubmitDraft(view: {
  id: string;
  preview: string;
  warnings: string[];
  original: {reason: string; startTime: string; endTime: string; img: string};
  reason: string;
  ttlSeconds: number;
}): string {
  const lines = [view.preview];
  if (view.warnings.length) {
    lines.push('', '**要注意：**');
    for (const item of view.warnings) lines.push(`- ${item}`);
  }
  lines.push('', `草稿号 \`${view.id}\`，${Math.round(view.ttlSeconds / 60)} 分钟内有效。`);
  lines.push('', '**下一步**：回复「提交」我就发出去。要改说明直接说，我重出一张。');
  lines.push('站点规则：重提是**覆盖原单**（不新增单号），原申请会回到待审队列。');
  return lines.join('\n');
}

/** 驳回重提：结果。 */
export function renderResubmitResult(value: {code?: number; msg?: string}): string {
  if (value.code === 0 || value.code === 200 || value.code === 201 || value.code === 202) {
    return '**已重新提交**（覆盖原单，回到待审队列）。要查进度说「查我的请假」。';
  }
  return `重新提交失败（code ${value.code ?? '?'}）：${value.msg || '后端没给原因'}。草稿还在，可以改完再试。`;
}

/** 通用写草稿的确认卡：只负责把 preview + 警告 + 下一步拼好。 */
export function renderWriteDraft(title: string, view: {id: string; preview: string; warnings?: string[]; ttlSeconds: number}): string {
  const lines = [view.preview];
  const warnings = view.warnings || [];
  if (warnings.length) {
    lines.push('', '**要注意：**');
    for (const item of warnings) lines.push(`- ${item}`);
  }
  lines.push('', `草稿号 \`${view.id}\`，${Math.round(view.ttlSeconds / 60)} 分钟内有效。`);
  lines.push('', `**下一步**：回复「提交」我就把这条${title}发出去；要改内容直接说，我重出一张。`);
  return lines.join('\n');
}

/** 通用写结果。 */
export function renderWriteResult(title: string, value: {code?: number; msg?: string}): string {
  if (value.code === 0 || value.code === 200 || value.code === 201 || value.code === 202) {
    return `**${title}已提交**（后端回 ${value.code}）。`;
  }
  return `${title}提交失败（code ${value.code ?? '?'}）：${value.msg || '后端没给原因'}。草稿还在，可以改完再试。`;
}

/** 销假 / 返校结果。 */export function renderClose(action: 'melt' | 'return' | 'resubmit', envelope: {code?: number; msg?: string}): string {
  const label = action === 'melt' ? '销假' : action === 'return' ? '返校登记' : '重新提交';
  if (envelope.code === 0 || envelope.code === 200 || envelope.code === 201 || envelope.code === 202) {
    return `${label}成功。`;
  }
  return `${label}失败（code ${envelope.code ?? '?'}）：${envelope.msg || '后端没给原因'}`;
}
