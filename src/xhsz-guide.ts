// 智慧思政「引导卡」：那些 AI 不该代填、但用户需要一条准确路径的事务。
//
// 为什么要有这个文件：写接口清单一共 332 条，真正适合代填的只有请假/勤工助学这类
// 「字段固定、单步提交」的。剩下的要么是多步向导（外宿申请要先建单拿到 outId，
// 后面每步都依赖它）、要么要扫楼栋二维码（归寝）、要么根本不在本站（心理预约是
// 另一个域名）。对这些硬凑接口，只会生成一张必然失败的假条。
//
// 所以这里不碰任何接口，只回答三件事：入口在哪、要准备什么、AI 能帮到哪一步。

export interface GuideTopic {
  key: string;
  title: string;
  /** 站点路由（拼在 https://nxg.zwu.edu.cn/zhxg/# 后面），外链则给完整 URL。 */
  path: string;
  external?: boolean;
  /** 为什么要本人操作。 */
  why: string;
  /** 进去之前要准备好的东西。 */
  prepare: string[];
  /** AI 能帮到哪一步。 */
  aiCan: string;
}

export const GUIDE_TOPICS: GuideTopic[] = [
  {
    key: '外宿申请',
    title: '外宿申请',
    path: '/newDorm/outDorm/student/auditList',
    why: '站点是多步向导：第一步建单拿 outId，后面选地址、上传家长知情材料、提交审批都依赖它，中间还要家长/辅导员确认。AI 一路代填等于替你和家长签字。',
    prepare: ['外宿地址（省市区 + 详细地址）', '家长知情同意（通常要照片）', '紧急联系电话', '起止日期'],
    aiCan: '帮你把地址、起止日期、事由整理成一段可直接粘贴的文字；查你的外宿申请现在走到哪一步。'
  },
  {
    key: '退宿申请',
    title: '退宿申请',
    path: '/s/stuRoom/submitReason',
    why: '退宿要选楼栋/床位、上传材料，还会牵出住宿费结算，提交后不能自助撤回。',
    prepare: ['退宿原因', '预计退宿日期', '相关证明（如有）'],
    aiCan: '整理退宿理由的书面表述；提醒你要不要先办离校物品清点。'
  },
  {
    key: '调寝',
    title: '调寝记录',
    path: '/s/stuRoom/newExBedRecord',
    why: '调寝由辅导员和宿管双向确认，学生端只能看记录和提交申请，不能直接改床位。',
    prepare: ['目标楼栋/寝室（可选）', '调寝理由'],
    aiCan: '查你的调寝申请进度（`getStuChangeBeds`）。'
  },
  {
    key: '奖学金',
    title: '奖学金申请',
    path: '/scholarship/student/list',
    why: '申请要填家庭经济情况、获奖经历、上传证明材料，且一年只有一次窗口期，填错影响评定。',
    prepare: ['成绩单截图', '获奖证书照片', '家庭经济情况说明', '个人陈述'],
    aiCan: '帮你写个人陈述的初稿；查你有没有在评的申请。'
  },
  {
    key: '卓越奖',
    title: '万里卓越奖',
    path: '/excellenceAward/student/list',
    why: '要上传事迹材料与证明，学院初审 + 学校复审，材料不可事后补交。',
    prepare: ['事迹材料', '证明材料照片'],
    aiCan: '查历史获奖记录（`excellence/historyList`）；帮你把事迹整理成条目。'
  },
  {
    key: '学分',
    title: '生活思政学分',
    path: '/lifePractice/signup/list',
    why: '学分申报要绑定具体活动（hdId）并上传活动附件，系统按活动核验，凑不出活动就报不了。',
    prepare: ['参加的活动名称与时间', '活动证明/照片'],
    aiCan: '查到你的学分明细和排名；告诉你还差哪几类。'
  },
  {
    key: '勤工助学报名',
    title: '勤工助学岗位报名',
    path: '/workAid/workbench',
    why: '报名表要上传课表截图（kbImg）、填特长（speciality）等字段，缺一项后端就拒；岗位还有名额和审核。',
    prepare: ['本学期课表截图', '特长/技能清单', '可工作时间段'],
    aiCan: '列出当前在招岗位；撤回已报名（这两件已经做成工具了）。'
  },
  {
    key: '归寝签到',
    title: '归寝确认',
    path: 'https://wisdom.zwu.edu.cn/wisdom-platform-app/#/connect?redirectUrl=/student/signIn',
    external: true,
    why: '归寝要在宿舍楼扫码定位签到，是「人必须在现场」的证明，代签没有意义（也过不了定位校验）。',
    prepare: ['人在宿舍', '手机能定位'],
    aiCan: '只能提醒你几点前要签、晚归要怎么报备。'
  },
  {
    key: '心理预约',
    title: '心理咨询预约',
    path: 'https://xlyy.zwu.edu.cn/mobile/login',
    external: true,
    why: '心理咨询在另一个系统（xlyy.zwu.edu.cn），独立登录，且咨询内容属于隐私，AI 不代填。',
    prepare: ['学号', '想聊的方向（可选）'],
    aiCan: '告诉你入口和大概流程；不碰你的咨询内容。'
  },
  {
    key: '信息采集',
    title: '基础信息采集',
    path: '/messCollection/index',
    why: '家庭住址、家庭成员、贷款、贫困认定这些字段一旦填错会影响资助资格，且部分要辅导员复核。',
    prepare: ['家庭详细地址', '家庭成员信息', '（如有）贷款合同信息'],
    aiCan: '查你还差哪几项没填（`collect/collectHome`）。'
  },
  {
    key: '手册考试',
    title: '学生手册考试',
    path: '/manualExam/student/home',
    why: '考试有防作弊与次数限制，代答等于作弊。',
    prepare: ['读完学生手册'],
    aiCan: '查你考没考、还剩几次机会（`manualExam/status`）。'
  }
];

export function findGuide(topic: string): GuideTopic[] {
  const text = String(topic || '').trim();
  if (!text) return GUIDE_TOPICS;
  const hits = GUIDE_TOPICS.filter(item => item.key.includes(text) || item.title.includes(text) || text.includes(item.key));
  return hits.length ? hits : GUIDE_TOPICS;
}

export function renderGuide(topics: GuideTopic[]): string {
  if (!topics.length) return '没有匹配的事项。用 `xhsz_guide` 不带参数可以看到全部清单。';
  const lines: string[] = [];
  for (const topic of topics) {
    const url = topic.external ? topic.path : `https://nxg.zwu.edu.cn/zhxg/#${topic.path}`;
    lines.push(`### ${topic.title}`);
    lines.push('');
    lines.push(`- 入口：${url}`);
    lines.push(`- **为什么不能代填**：${topic.why}`);
    if (topic.prepare.length) lines.push(`- 进去前准备好：${topic.prepare.join('；')}`);
    lines.push(`- 我能帮到：${topic.aiCan}`);
    lines.push('');
  }
  lines.push('要我为哪一项整理文字材料，直接说。');
  return lines.join('\n').trim();
}
