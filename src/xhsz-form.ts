// 智慧思政 · 受控通用写执行器。
//
// ---------- 为什么需要它 ----------
//
// 前面那些专用工具（请假、勤工助学）是「高频 + 字段固定 + 值得做好」的部分。
// 但学生端还有 30 多个写接口，逐个写工具不现实 —— 而且大多只用一次。
// 于是有了这一层：**白名单 + 确认卡 + 草稿作废**的通用执行器。
//
// 和「让模型随便调接口」的区别（这是全部安全感来源）：
//   1. action 必须在白名单里，白名单只收学生端写接口，教师端/考试/管理端一条都不收；
//   2. 每个 action 声明了它自己的字段集，模型只能传这些键，多一个都拒；
//   3. 一律走 draft → 确认卡（把 action 的中文名、每个字段的键值全展开）→ 用户说「提交」；
//   4. 一个草稿只能用一次，10 分钟过期，失败不自动重试。
//
// 换句话说：**模型不能凭空发明一个请求**，只能在人已经批准的模板里填值。

export interface FormAction {
  /** 接口路径（相对 https://nxg.zwu.edu.cn/api）。 */
  action: string;
  /** 中文名，确认卡上用。 */
  label: string;
  /** 允许的字段。空数组 = 该接口没有固定字段（表单对象整体提交），此时只允许这些键。 */
  fields: string[];
  /** 一句话风险说明，确认卡上必须显示。 */
  danger: string;
}

/**
 * 学生端写接口白名单。
 *
 * 收录标准（三条全中）：
 *   ① 路径在 `/s/**` 或 `/c/**` 的学生区（不是 `/t/**` 教师端）；
 *   ② 学生用自己账号真的会用；
 *   ③ 不是考试、不是短信、不是改手机号/人脸。
 *
 * 字段来源：站点前端源码里 `$post(HOST + '/x/y', payload)` 的 payload 键名（静态反推），
 * 拿不到确切字段的写 `[]` 表示「按站点表单原样传」。
 */
export const FORM_ACTIONS: FormAction[] = [
  {
    action: '/s/credit/sbSubmit',
    label: '生活思政学分申报',
    fields: ['studentId', 'hdId', 'hdSj', 'attachment', 'content', 'score'],
    danger: '申报后进入审核队列，材料不全会被退回；同一活动通常只能申报一次。'
  },
  {
    action: '/c/credit/scanConfirm',
    label: '学分活动扫码确认',
    fields: ['path', 'query', 'type', 'dealData', 'loginConfig', 'loadData'],
    danger: '扫码确认会直接给你的活动记分，不能撤销。'
  },
  {
    action: '/c/workAid/apply/commit',
    label: '勤工助学岗位报名',
    fields: ['jobId', 'studentId', 'kbImg', 'speciality', 'reason', 'phone', 'applyReason'],
    danger: '报名要带本学期课表截图（kbImg），字段缺一项后端就拒；报名后等用工部门审核。'
  },
  {
    action: '/c/workAid/apply/withdraw',
    label: '撤回勤工助学报名',
    fields: ['id', 'studentId'],
    danger: '撤回后报名记录消失，要重新报名并重新审核。'
  },
  {
    action: '/c/workAid/apply/quit',
    label: '勤工助学离职',
    fields: ['id', 'teacherId', 'note'],
    danger: '离职会终止在岗记录，影响当月工时结算。'
  },
  {
    action: '/c/workAid/eval/submitStudentOpinion',
    label: '勤工助学月度意见',
    fields: ['studentId', 'applyId', 'monthKey', 'hasSuggestion', 'content'],
    danger: '一个月一条，重复提交可能覆盖上一条。'
  },
  {
    action: '/c/workAid/survey/save',
    label: '勤工助学问卷',
    fields: ['roleType', 'personId', 'answersJson'],
    danger: '问卷提交后一般不能修改。'
  },
  {
    action: '/s/scholarship/submit',
    label: '奖学金申请',
    fields: ['studentId', 'id', 'reason', 'content', 'attachment', 'score'],
    danger: '一年一次窗口期，材料不可事后补交，提交后由学院初审。'
  },
  {
    action: '/s/excellent/submitApply',
    label: '万里卓越奖申请',
    fields: ['studentId', 'content', 'attachment', 'award'],
    danger: '要附事迹材料与证明，学院初审 + 学校复审，材料不补交。'
  },
  {
    action: '/s/poorStudent/student/poorApply',
    label: '家庭经济困难认定申请',
    fields: ['studentId', 'content', 'attachment', 'level'],
    danger: '影响资助资格，字段填错要重新认定；建议本人核对后再提交。'
  },
  {
    action: '/s/stuRoom/submitReason',
    label: '退宿申请',
    fields: ['studentId', 'reason', 'bedroomId', 'attachment'],
    danger: '退宿牵出住宿费结算，提交后不能自助撤回。'
  },
  {
    action: '/s/outSchool/outSchoolApply',
    label: '外宿申请（第一步建单）',
    fields: ['studentId', 'startTime', 'endTime', 'reason', 'address', 'tzName', 'tzPhone', 'type'],
    danger: '这是多步向导的第一步，只建单；后续步骤要在页面里走（涉及家长材料与辅导员确认）。'
  },
  {
    action: '/s/leave/school/saveRegister',
    label: '假期离校登记',
    fields: ['studentId', 'goBack', 'content', 'address'],
    danger: '离校登记用于假期去向备案，填了要保证行程一致。'
  },
  {
    action: '/s/vacation/addVacationLeave',
    label: '假期请假（寒暑假）',
    fields: ['studentId', 'leaveId', 'status', 'content'],
    danger: '假期请假走单独流程，和日常请假不共用单号。'
  },
  {
    action: '/s/heart/addChat',
    label: '心理咨询预约',
    fields: ['type', 'classId', 'studentId', 'timesId'],
    danger: '预约会占用咨询师时段；取消要提前（cancelChat）。'
  },
  {
    action: '/s/heart/cancelChat',
    label: '取消心理咨询预约',
    fields: ['recordId'],
    danger: '取消后时段会释放给别人，临时取消请尽早。'
  },
  {
    action: '/s/submitAttendData',
    label: '考勤数据申诉',
    fields: ['classname', 'content', 'date', 'lessons', 'studentId', 'type', 'time'],
    danger: '申诉进入教师审核，理由要写清楚；不能改已归档的考勤。'
  },
  {
    action: '/s/gpsSign',
    label: '定位签到',
    fields: ['lat', 'lng', 'studentId'],
    danger: '签到用的是真实定位；代签等于伪造考勤。'
  },
  {
    action: '/s/signAreaPlace',
    label: '区域签到',
    fields: ['lat', 'lng', 'judgeSign'],
    danger: '同上，位置由设备提供。'
  },
  {
    action: '/s/nightSaoSubmit',
    label: '归寝扫码签到',
    fields: ['imageCode', 'studentId', 'time', 'wangui'],
    danger: '需要楼栋二维码（imageCode），人不在现场签不了。'
  },
  {
    action: '/s/laterSaoSubmit',
    label: '晚归报备',
    fields: ['studentId', 'reason', 'time'],
    danger: '晚归报备要如实填时间与原因。'
  },
  {
    action: '/s/backhome/submit',
    label: '返乡报备',
    fields: ['studentId', 'content', 'address', 'time'],
    danger: '报备内容会同步给辅导员。'
  },
  {
    action: '/s/submitBuyTrain',
    label: '假期火车票购买登记',
    fields: ['studentId', 'backProvince', 'backCity', 'ifBuy'],
    danger: '用于学校统计与统一购票，填错影响行程安排。'
  },
  {
    action: '/c/stu/submitBus',
    label: '校车乘车登记',
    fields: ['studentId', 'yesNo', 'times'],
    danger: '登记后按班次占位。'
  },
  {
    action: '/s/collect/bedroom/submitBedroom',
    label: '寝室信息采集',
    fields: ['studentId', 'getData'],
    danger: '寝室信息与住宿费、门禁关联，填错要重录。'
  },
  {
    action: '/c/collect/submitBasicInfo',
    label: '基础信息采集（基本信息）',
    fields: ['studentId', 'content'],
    danger: '个人信息字段填错会影响资助与评奖资格。'
  },
  {
    action: '/c/collect/submitContact',
    label: '基础信息采集（联系方式）',
    fields: ['studentId', 'content'],
    danger: '联系方式要真实，紧急情况靠它联系。'
  },
  {
    action: '/c/collect/submitHome',
    label: '基础信息采集（家庭信息）',
    fields: ['studentId', 'content'],
    danger: '家庭信息用于资助认定，不实会影响资格。'
  },
  {
    action: '/c/collect/submitHomeMember',
    label: '基础信息采集（家庭成员）',
    fields: ['studentId', 'content'],
    danger: '家庭成员信息会被辅导员复核。'
  },
  {
    action: '/c/collect/submitLoanInfo',
    label: '助学贷款信息登记',
    fields: ['studentId', 'img', 'isLoan', 'price'],
    danger: '贷款金额与合同要一致，错了影响放款。'
  },
  {
    action: '/c/collect/submitPoverty',
    label: '贫困认定信息',
    fields: ['studentId', 'content'],
    danger: '属于资助认定的核心材料，如实填写。'
  },
  {
    action: '/c/collect/submitResume',
    label: '个人简历提交',
    fields: ['studentId', 'content', 'award'],
    danger: '简历会用于推荐与评优。'
  },
  {
    action: '/c/stu/urgentSave',
    label: '紧急联系人登记',
    fields: ['studentId', 'name', 'phone', 'relation'],
    danger: '紧急联系人必须是能联系上的真人。'
  },
  {
    action: '/c/Tsz/addOtherAwardInfo',
    label: '其他获奖信息补充',
    fields: ['studentId', 'saveImg', 'time', 'content'],
    danger: '获奖信息用于综测与评优，要附证明。'
  },
  {
    action: '/s/welcome/submitSurveyQuestion',
    label: '迎新问卷提交',
    fields: ['studentId', 'content', 'answers'],
    danger: '问卷一般只能提交一次。'
  }
];

const BY_ACTION = new Map(FORM_ACTIONS.map(item => [item.action, item]));

export function findFormAction(action: string): FormAction | undefined {
  return BY_ACTION.get(String(action || '').trim());
}

/** 所有可用 action 的清单（给人看的，也是模型能选的菜单）。 */
export function listFormActions(): FormAction[] {
  return FORM_ACTIONS.slice();
}

export interface PayloadCheck {
  ok: boolean;
  /** 不在白名单字段里的键（会被拒）。 */
  unexpected: string[];
  /** 值为空的键（提醒，不阻断）。 */
  empty: string[];
}

/** 校验 payload：只允许声明的字段，值必须是标量。 */
export function checkPayload(spec: FormAction, payload: Record<string, unknown>): PayloadCheck {
  // 没声明字段的 action = 我们还没摸清它的表单，一律不放行（宁可报错，不要瞎填）。
  if (!spec.fields.length) {
    return {ok: false, unexpected: Object.keys(payload || {}), empty: []};
  }
  const allowed = new Set(spec.fields);
  const unexpected: string[] = [];
  const empty: string[] = [];
  for (const [key, value] of Object.entries(payload || {})) {
    if (!allowed.has(key)) unexpected.push(key);
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (!text) empty.push(key);
  }
  return {ok: unexpected.length === 0, unexpected, empty};
}

export function renderFormActions(): string {
  const lines = ['### 通用写接口（受控白名单）', '', '| 接口 | 名称 | 允许的字段 |', '|---|---|---|'];
  for (const item of FORM_ACTIONS) {
    lines.push(`| \`${item.action}\` | ${item.label} | ${item.fields.length ? item.fields.join('、') : '按站点表单原样'} |`);
  }
  lines.push('', `共 ${FORM_ACTIONS.length} 条。用 \`xhsz_form_draft\` 填字段，看过确认卡再说「提交」。`);
  return lines.join('\n');
}
