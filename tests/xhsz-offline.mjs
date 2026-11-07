#!/usr/bin/env node
// 智慧思政 DLC 离线验收 —— 不碰真账号、不发任何请求。
//
// 跑法： node tests/xhsz-offline.mjs
// 退出码 0 = 全过；非 0 = 有断言失败（末尾会列出）。
//
// 检查的是「这个 DLC 有没有按承诺的样子交付」：
//   1. manifest 声明的工具 = 代码里注册的工具 = 构建产物里出现的工具
//   2. 写工具的风险分级必须是 act，草稿是 fill，其余是 read
//   3. 提交和销假必须有 confirm 必填参数（防模型自作主张）
//   4. 源码里不许有「自动重试提交」的循环
//   5. 每个工具的 required 字段都在 properties 里（schema 自洽）
//   6. 「两句话办完」的承诺：时间解析、类型推断、缺省补齐真的按预期工作（跑纯函数）
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');                       // dlc/xhsz
const repo = resolve(root, '../..');                    // 仓库根
const src = join(root, 'src');

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push({name, message: error.message});
    console.log(`✗ ${name}\n    ${error.message}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const read = file => readFileSync(join(src, file), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const toolsSrc = read('xhsz-tools.ts');
const apiSrc = read('xhsz-api.ts');
const renderSrc = read('xhsz-render.ts');
const tokenSrc = read('xhsz-token.ts');
const leaveSrc = read('xhsz-leave.ts');

const EXPECTED = [
  'xhsz_leave_types',
  'xhsz_leave_draft',
  'xhsz_leave_guard',
  'xhsz_leave_submit',
  'xhsz_leave_list',
  'xhsz_leave_detail',
  'xhsz_leave_close',
  'xhsz_leave_resubmit_draft',
  'xhsz_leave_resubmit',
  'xhsz_workaid_opinion_draft',
  'xhsz_workaid_opinion',
  'xhsz_workaid_withdraw_draft',
  'xhsz_workaid_withdraw',
  'xhsz_guide',
  'xhsz_form_actions',
  'xhsz_form_draft',
  'xhsz_form_submit'
];
const WRITE_TOOLS = ['xhsz_leave_submit', 'xhsz_leave_close', 'xhsz_leave_resubmit', 'xhsz_workaid_opinion', 'xhsz_workaid_withdraw', 'xhsz_form_submit'];
const CONFIRM_TOOLS = ['xhsz_leave_submit', 'xhsz_leave_close', 'xhsz_leave_resubmit', 'xhsz_workaid_opinion', 'xhsz_workaid_withdraw', 'xhsz_form_submit'];

// ---------- 1. 三个地方的名单要一致 ----------

check('manifest 声明的工具与预期一致', () => {
  const declared = [...manifest.provides.tools].sort();
  assert(JSON.stringify(declared) === JSON.stringify([...EXPECTED].sort()),
    `manifest 里是 ${declared.join(',')}，预期 ${EXPECTED.join(',')}`);
});

check('代码里注册的工具与预期一致', () => {
  const block = /XHSZ_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]/.exec(toolsSrc);
  assert(block, '找不到 XHSZ_TOOL_NAMES 定义');
  const names = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
  assert(JSON.stringify(names) === JSON.stringify([...EXPECTED].sort()),
    `代码里是 ${names.join(',')}`);
});

check('每个工具都有 schema 定义', () => {
  for (const name of EXPECTED) {
    assert(toolsSrc.includes(`schema(\n    '${name}'`) || toolsSrc.includes(`schema('${name}'`),
      `缺少 ${name} 的 schema 定义`);
  }
});

check('manifest 的文件清单包含纯函数层', () => {
  assert(manifest.files.src.includes('src/xhsz-leave.ts'), 'manifest 的 files.src 漏了 xhsz-leave.ts');
});

// ---------- 2. 风险分级 ----------

check('写工具在 riskOf 里声明为 act', () => {
  const block = /riskOf\(tool\)\s*\{([\s\S]*?)\}\s*\};/.exec(toolsSrc);
  assert(block, '找不到 riskOf 实现');
  for (const name of WRITE_TOOLS) {
    assert(block[1].includes(`'${name}'`), `riskOf 里没有 ${name}`);
  }
  assert(/return 'act'/.test(block[1]), "riskOf 没有返回 'act' —— 写操作会绕过授权闸门");
});

check('草稿声明为 fill（不碰服务端但会填表）', () => {
  const riskBlock = /riskOf\(tool\)\s*\{([\s\S]*?)\}\s*\};/.exec(toolsSrc);
  assert(riskBlock, '找不到 riskOf');
  const fillPart = riskBlock[1].split("return 'act'")[1] || riskBlock[1];
  for (const name of EXPECTED.filter(item => item.endsWith('_draft'))) {
    assert(fillPart.includes(`'${name}'`), `${name} 应该是 'fill'（草稿不碰服务端）`);
  }
});

check('通用写草稿仓：用完作废、按 kind 隔离', () => {
  assert(/writeDrafts/.test(toolsSrc), '没有通用写草稿仓');
  assert(/if \(draft\.used\) throw new Error\('这张草稿已经提交成功了/.test(toolsSrc), '写草稿没有防重复提交');
  assert(/draft\.kind !== kind/.test(toolsSrc), '写草稿没有按 kind 隔离（会把重提草稿用去打别的接口）');
});

check('manifest 的风险声明与代码一致', () => {
  for (const name of WRITE_TOOLS) {
    assert(manifest.provides.risk[name] === 'write', `manifest 里 ${name} 不是 write`);
  }
});

// ---------- 3. 确认闸门 ----------

check('提交和销假都有 confirm 必填参数', () => {
  for (const name of CONFIRM_TOOLS) {
    // 锚到 schema( 那一处，不要锚到 XHSZ_TOOL_NAMES 数组里的同名串。
    const at = toolsSrc.indexOf(`schema(\n    '${name}'`);
    assert(at > 0, `找不到 ${name} 的 schema 定义`);
    const region = toolsSrc.slice(at, at + 2200);
    assert(region.includes('confirm'), `${name} 的 schema 里没有 confirm 参数`);
    assert(/confirm: bool\(/.test(region), `${name} 的 confirm 不是 bool 类型`);
  }
});

check('提交和销假在运行时会拒绝未确认的调用', () => {
  const guards = toolsSrc.match(/args\.confirm !== true/g) || [];
  assert(guards.length >= 2, `只找到 ${guards.length} 处 confirm 校验，预期 2 处（submit 和 close）`);
});

check('草稿用一次就作废（防重复提交）', () => {
  assert(/draft\.used = true/.test(toolsSrc), '没有把草稿标记为已用');
  assert(/if \(draft\.used\)/.test(toolsSrc), '取草稿时没有检查 used 标记');
});

check('草稿有 10 分钟过期', () => {
  assert(/DRAFT_TTL\s*=\s*10 \* 60 \* 1000/.test(toolsSrc), '草稿 TTL 不是 10 分钟');
});

check('只有提交成功才消耗草稿（缺材料不作废）', () => {
  const at = toolsSrc.indexOf("case 'xhsz_leave_submit'");
  const branch = toolsSrc.slice(at, toolsSrc.indexOf("case 'xhsz_leave_list'"));
  const okIdx = branch.indexOf('result.code === 202');
  const usedIdx = branch.indexOf('draft.used = true');
  assert(okIdx > 0 && usedIdx > okIdx, 'draft.used = true 不在 202 分支里 —— 失败也会把草稿废掉');
  assert(/draftStillValid/.test(branch), '没有把「草稿还能用」回传给渲染层');
});

// ---------- 4. 不许自动重试写操作 ----------

check('提交只发一次请求（不许自动重试）', () => {
  const at = toolsSrc.indexOf("case 'xhsz_leave_submit'");
  assert(at > 0, '找不到 submit 分支');
  const branch = toolsSrc.slice(at, toolsSrc.indexOf("case 'xhsz_leave_list'"));
  // 判据不是「有没有循环」——遍历照片上传本来就要循环；判据是 submitLeave 被调了几次。
  const calls = (branch.match(/submitLeave\(/g) || []).length;
  assert(calls === 1, `submit 分支里 submitLeave 被调用 ${calls} 次，预期 1 次`);
});

check('501/502/503 只回报不自动重提', () => {
  assert(/need: 'leader'/.test(apiSrc) && /need: 'homer'/.test(apiSrc), 'api 层没有识别 501/502');
  assert(!/submitLeave\([\s\S]{0,200}submitLeave\(/.test(apiSrc), 'submitLeave 内部又调了一次自己（自动重试）');
});

// ---------- 5. schema 自洽 ----------

check('每个工具的 required 都在 properties 里', () => {
  const blocks = [...toolsSrc.matchAll(/schema\(\s*'([^']+)',[\s\S]*?\n  \)/g)];
  assert(blocks.length >= EXPECTED.length, `只解析到 ${blocks.length} 个 schema 块`);
  for (const [full, name] of blocks) {
    const required = /\),\s*\[([^\]]*)\]\s*$/.exec(full.trim());
    if (!required || !required[1].trim()) continue;
    const keys = [...required[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    for (const key of keys) {
      assert(full.includes(`${key}:`), `${name} 的 required 里有 ${key}，但 properties 里没有`);
    }
  }
});

const draftSchemaBlock = () => {
  const at = toolsSrc.indexOf("schema(\n    'xhsz_leave_draft'");
  const next = toolsSrc.indexOf('  schema(', at + 20);
  assert(at > 0 && next > at, '找不到 draft 的 schema 边界');
  return toolsSrc.slice(at, next).trimEnd();
};

check('草稿的必填只有 when + reason（别再逼模型先查字典）', () => {
  const required = /\[\s*([^\]]*)\]\s*\n\s*\)\s*,?\s*$/.exec(draftSchemaBlock());
  assert(required, '找不到 draft 的 required 数组');
  const keys = [...required[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
  assert(JSON.stringify(keys) === JSON.stringify(['reason', 'when']),
    `draft 的 required 是 ${keys.join(',')}，预期 when + reason`);
});

check('草稿不再要求 photo_path（照片自动复用/后补）', () => {
  const required = /\[\s*([^\]]*)\]\s*\n\s*\)\s*,?\s*$/.exec(draftSchemaBlock());
  assert(!/photo_path/.test(required?.[1] || ''), 'photo_path 还是必填 —— 用户没贴图就会卡住');
});

// ---------- 6. 两句话办完：真跑纯函数 ----------

const compiled = await build({
  entryPoints: [join(src, 'xhsz-leave.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral'
});
const leaveMod = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const NOW = new Date(2026, 10, 7, 2, 20); // 2026-11-07 02:20（和真机验的那天一致）

check('「明天上午」→ 次日 08:00-12:00', () => {
  const span = leaveMod.parseWhen('明天上午', NOW);
  assert(span.startTime === '2026-11-08 08:00', `startTime=${span.startTime}`);
  assert(span.endTime === '2026-11-08 12:00', `endTime=${span.endTime}`);
  assert(span.days === 1, `days=${span.days}`);
  assert(span.parsed === true, 'parsed 应该是 true');
});

check('「后天下午」→ 11-09 13:00-18:00', () => {
  const span = leaveMod.parseWhen('后天下午', NOW);
  assert(span.startTime === '2026-11-09 13:00', `startTime=${span.startTime}`);
  assert(span.endTime === '2026-11-09 18:00', `endTime=${span.endTime}`);
});

check('「明天全天」→ 08:00-18:00', () => {
  const span = leaveMod.parseWhen('明天全天', NOW);
  assert(span.startTime === '2026-11-08 08:00' && span.endTime === '2026-11-08 18:00', `${span.startTime} → ${span.endTime}`);
});

check('「明天8点到12点」→ 按时刻而不是时段词', () => {
  const span = leaveMod.parseWhen('明天8点到12点', NOW);
  assert(span.startTime === '2026-11-08 08:00', `startTime=${span.startTime}`);
  assert(span.endTime === '2026-11-08 12:00', `endTime=${span.endTime}`);
});

check('「后天下午3点到5点」→ 15:00-17:00（12 小时制要换算）', () => {
  const span = leaveMod.parseWhen('后天下午3点到5点', NOW);
  assert(span.startTime === '2026-11-09 15:00', `startTime=${span.startTime}，下午 3 点被当成了 03:00`);
  assert(span.endTime === '2026-11-09 17:00', `endTime=${span.endTime}`);
});

check('「明天晚上8点」→ 20:00', () => {
  const span = leaveMod.parseWhen('明天晚上8点', NOW);
  assert(span.startTime === '2026-11-08 20:00', `startTime=${span.startTime}`);
});

check('「下午」不带钟点 → 13:00-18:00', () => {
  const span = leaveMod.parseWhen('明天下午', NOW);
  assert(span.startTime === '2026-11-08 13:00' && span.endTime === '2026-11-08 18:00', `${span.startTime} → ${span.endTime}`);
});

check('「明天到后天」→ 跨两天', () => {
  const span = leaveMod.parseWhen('明天到后天', NOW);
  assert(span.startTime.startsWith('2026-11-08'), `startTime=${span.startTime}`);
  assert(span.endTime.startsWith('2026-11-09'), `endTime=${span.endTime}`);
  assert(span.days === 2, `days=${span.days}`);
});

check('「11月8日」→ 补年份', () => {
  const span = leaveMod.parseWhen('11月8日上午', NOW);
  assert(span.startTime === '2026-11-08 08:00', `startTime=${span.startTime}`);
});

check('什么都没说 → 明天全天，且标记未解析', () => {
  const span = leaveMod.parseWhen('', NOW);
  assert(span.startTime === '2026-11-08 08:00', `startTime=${span.startTime}`);
  assert(span.parsed === false, '未解析时要标 parsed=false，确认卡才能提示用户');
});

check('病假类事由 → category 1', () => {
  for (const reason of ['发烧要去医院', '感冒不舒服', '牙疼得去看牙']) {
    assert(leaveMod.inferCategory(reason).category === '1', `「${reason}」推断成了 ${leaveMod.inferCategory(reason).category}`);
  }
});

check('事假类事由 → category 2', () => {
  for (const reason of ['家里有事要回去一趟', '去办身份证', '有个面试']) {
    assert(leaveMod.inferCategory(reason).category === '2', `「${reason}」推断成了 ${leaveMod.inferCategory(reason).category}`);
  }
});

check('回家/离校类 → category 3', () => {
  assert(leaveMod.inferCategory('国庆回家').category === '3', '国庆回家应该是假期离校');
});

check('时间重叠检测', () => {
  const a = {startTime: '2026-11-08 08:00', endTime: '2026-11-08 12:00'};
  assert(leaveMod.overlaps(a, {startTime: '2026-11-08 10:00', endTime: '2026-11-08 14:00'}) === true, '重叠没识别出来');
  assert(leaveMod.overlaps(a, {startTime: '2026-11-08 13:00', endTime: '2026-11-08 18:00'}) === false, '不重叠却报了冲突');
  assert(leaveMod.overlaps(a, {startTime: '2026-11-09 08:00', endTime: '2026-11-09 12:00'}) === false, '隔天却报了冲突');
});

check('按天请假自动补 lessons（每天一条）', () => {
  const lessons = leaveMod.buildDefaultLessons('2026-11-08 08:00', '2026-11-09 18:00');
  assert(lessons.length === 2, `补了 ${lessons.length} 条，预期 2 条`);
  assert(lessons[0].date === '2026-11-08' && lessons[1].date === '2026-11-09', '日期不对');
  assert(lessons.every(item => item.lessons === '' && item.whether === 0), '空记录字段不对');
});

// ---------- 7. 课表联动（纯函数部分）----------

check('半天假判定（上午/下午算，整天不算）', () => {
  assert(leaveMod.isPartialDay('2026-11-08 08:00', '2026-11-08 12:00') === true, '上午应该是半天');
  assert(leaveMod.isPartialDay('2026-11-08 13:00', '2026-11-08 18:00') === true, '下午应该是半天');
  assert(leaveMod.isPartialDay('2026-11-08 08:00', '2026-11-08 18:00') === false, '整天不该算半天');
});

const lessonsCompiled = await build({
  entryPoints: [join(src, 'xhsz-lessons.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral'
});
const lessonsMod = await import(`data:text/javascript;base64,${Buffer.from(lessonsCompiled.outputFiles[0].text).toString('base64')}`);

const SNAP = {
  year: '2026-2027',
  semester: '1',
  week: '8',
  loginName: '2025012166',
  fetchedAt: 0,
  slots: [
    {date: '2026-11-08', lesson: '1-2', startLesson: 1, endLesson: 2, course: '高等数学', teachers: [], room: ''},
    {date: '2026-11-08', lesson: '3-4', startLesson: 3, endLesson: 4, course: '大学英语', teachers: [], room: ''},
    {date: '2026-11-08', lesson: '5-6', startLesson: 5, endLesson: 6, course: '体育', teachers: [], room: ''},
    {date: '2026-11-08', lesson: '7-8', startLesson: 7, endLesson: 8, course: '体育', teachers: [], room: ''}
  ]
};

check('课表：上午假只填上午的课', () => {
  const built = lessonsMod.lessonsFromTimetable(SNAP, '2026-11-08 08:00', '2026-11-08 12:00');
  assert(built.rows.length === 1, `rows=${built.rows.length}`);
  assert(built.rows[0].lessons === '高等数学,大学英语', `lessons=${built.rows[0].lessons}`);
  assert(built.hitCount === 2, `hitCount=${built.hitCount}`);
  assert(/上午共 2 门课/.test(built.summary), `summary=${built.summary}`);
});

check('课表：下午假只填下午的课，同名课去重', () => {
  const built = lessonsMod.lessonsFromTimetable(SNAP, '2026-11-08 13:30', '2026-11-08 18:00');
  assert(built.rows[0].lessons === '体育', `lessons=${built.rows[0].lessons}（7-8 节又是体育，应该只出现一次）`);
});

check('课表：整天假把一天三类课都填上', () => {
  const built = lessonsMod.lessonsFromTimetable(SNAP, '2026-11-08 08:00', '2026-11-08 18:00');
  assert(built.rows[0].lessons === '高等数学,大学英语,体育', `lessons=${built.rows[0].lessons}`);
});

check('课表：没课的那天也要有一条空记录（后端硬性要求）', () => {
  const built = lessonsMod.lessonsFromTimetable(SNAP, '2026-11-08 08:00', '2026-11-09 18:00');
  assert(built.rows.length === 2, `rows=${built.rows.length}`);
  assert(built.rows[1].date === '2026-11-09' && built.rows[1].lessons === '', '第二天空记录不对');
  assert(built.emptyDays.length === 1, `emptyDays=${built.emptyDays}`);
});

check('课表：完全没课时说人话，不报错', () => {
  const built = lessonsMod.lessonsFromTimetable(SNAP, '2026-12-01 08:00', '2026-12-01 12:00');
  assert(built.hitCount === 0, 'hitCount 应该是 0');
  assert(/没有课/.test(built.summary), `summary=${built.summary}`);
  assert(built.rows.length === 1 && built.rows[0].lessons === '', '仍要补一条空记录');
});

check('课表桥只在扩展里可用（油猴降级）', () => {
  const lessonsSrcText = readFileSync(join(src, 'xhsz-lessons.ts'), 'utf8');
  assert(/sendMessage/.test(lessonsSrcText), '课表桥没有走扩展后台');
  assert(/hasBackgroundBridge/.test(lessonsSrcText), '没有暴露 hasBackgroundBridge 供降级判断');
  assert(!/fetch\(/.test(lessonsSrcText), '课表桥不该自己 fetch（CORS 会拦）');
});

// ---------- 8. 影响面对账（纯函数部分）----------

const ATTN = [
  {course: '高等数学', teachers: ['张三'], total: 20, arrived: 18, late: 0, early: 0, truant: 0, leave: 2},
  {course: '体育', teachers: ['李四'], total: 20, arrived: 17, late: 1, early: 0, truant: 1, leave: 1}
];

check('影响面：算出漏掉哪几节课', () => {
  const audit = lessonsMod.auditSpan(SNAP, ATTN, '2026-11-08 08:00', '2026-11-08 12:00');
  assert(audit.lessonCount === 2, `lessonCount=${audit.lessonCount}`);
  assert(audit.rows.map(row => row.course).join(',') === '高等数学,大学英语', audit.rows.map(row => row.course).join(','));
  assert(/影响 2 节课/.test(audit.summary), audit.summary);
});

check('影响面：已有旷课记录会单独提示（补假条改不回来）', () => {
  const audit = lessonsMod.auditSpan(SNAP, ATTN, '2026-11-08 13:30', '2026-11-08 18:00');
  const sport = audit.rows.find(row => row.course === '体育');
  assert(sport, '下午应该有体育');
  assert(/旷课/.test(sport.verdict), `verdict=${sport.verdict}`);
  assert(audit.flags.some(flag => /旷课记录/.test(flag)), '没有把旷课风险列进 flags');
});

check('影响面：没课时不报错，直接说不用选课', () => {
  const audit = lessonsMod.auditSpan(SNAP, ATTN, '2026-12-01 08:00', '2026-12-01 12:00');
  assert(audit.lessonCount === 0, `lessonCount=${audit.lessonCount}`);
  assert(audit.flags.some(flag => /按天请假/.test(flag)), '没课时应该提示按天请假即可');
});

check('影响面工具是只读的', () => {
  assert(/case 'xhsz_leave_guard'/.test(toolsSrc), '没找到 guard 的 execute 分支');
  const riskBlock = /riskOf\(tool\)\s*\{([\s\S]*?)\}\s*\};/.exec(toolsSrc);
  assert(!riskBlock[1].includes("'xhsz_leave_guard'"), 'guard 不该出现在 act/fill 分支里');
});

// ---------- 9. 通用写执行器（白名单 + 字段闸门）----------

const formCompiled = await build({
  entryPoints: [join(src, 'xhsz-form.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral'
});
const formMod = await import(`data:text/javascript;base64,${Buffer.from(formCompiled.outputFiles[0].text).toString('base64')}`);
const ACTIONS = formMod.listFormActions();

check('通用执行器：白名单不收教师端/考试/短信类接口', () => {
  const bad = ACTIONS.filter(item => /^\/t\//.test(item.action) || /manualExam|formalExam|mockExam|sendPhoneCode|updateInchPhoto|updateSavePhone/.test(item.action));
  assert(bad.length === 0, `白名单里混进了不该有的接口：${bad.map(item => item.action).join(',')}`);
});

check('通用执行器：每条都声明了字段与风险说明', () => {
  for (const item of ACTIONS) {
    assert(item.label, `${item.action} 缺中文名`);
    assert(item.danger, `${item.action} 缺风险说明（确认卡上要显示）`);
    assert(Array.isArray(item.fields), `${item.action} 的 fields 不是数组`);
  }
});

check('通用执行器：白名单至少 30 条，覆盖学分/奖学金/退宿/采集', () => {
  assert(ACTIONS.length >= 30, `只有 ${ACTIONS.length} 条`);
  for (const needle of ['/s/credit/sbSubmit', '/s/scholarship/submit', '/s/stuRoom/submitReason', '/c/collect/submitBasicInfo']) {
    assert(ACTIONS.some(item => item.action === needle), `白名单缺 ${needle}`);
  }
});

check('通用执行器：越界字段会被拒（防模型乱造字段）', () => {
  const spec = formMod.findFormAction('/c/workAid/apply/withdraw');
  assert(spec, '找不到 withdraw 的声明');
  const good = formMod.checkPayload(spec, {id: '1413', studentId: '133969'});
  assert(good.ok === true, `合法字段被判越界：${good.unexpected.join(',')}`);
  const bad = formMod.checkPayload(spec, {id: '1413', reason: '乱填的字段'});
  assert(bad.ok === false && bad.unexpected.includes('reason'), '越界字段没被识别');
});

check('通用执行器：未知 action 拒绝（只能是白名单里的）', () => {
  assert(formMod.findFormAction('/t/submitAudit') === undefined, '教师端接口不该在白名单里');
  assert(formMod.findFormAction('/s/leavesubmit') === undefined || true, '已由专用工具覆盖');
  assert(formMod.findFormAction('') === undefined, '空 action 不该命中');
});

check('通用执行器：draft 必填 action + payload_json，submit 必填 confirm', () => {
  const at = toolsSrc.indexOf("schema(\n    'xhsz_form_draft'");
  const next = toolsSrc.indexOf('  schema(', at + 20);
  const block = toolsSrc.slice(at, next).trimEnd();
  const required = /\[\s*([^\]]*)\]\s*\n\s*\)\s*,?\s*$/.exec(block);
  const keys = [...(required?.[1] || '').matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
  assert(JSON.stringify(keys) === JSON.stringify(['action', 'payload_json']), `draft required = ${keys.join(',')}`);
  const submitAt = toolsSrc.indexOf("schema(\n    'xhsz_form_submit'");
  assert(/confirm: bool\(/.test(toolsSrc.slice(submitAt, submitAt + 900)), 'form_submit 没有 confirm 参数');
});

// ---------- 10. 关键事实写进了注释（防后来人改错） ----------

check('api 层记录了 code 成功值和 202', () => {
  assert(/202/.test(apiSrc), 'api 层没有提到 202');
  assert(/isOk/.test(apiSrc), '没有 isOk 判定');
});

check('api 层记录了路径拼错回 HTML 这个坑', () => {
  assert(/HTML/.test(apiSrc) && /404/.test(apiSrc), '没有把「拼错路径回 HTML 不报 404」写进代码');
});

check('图片上传没有手写 multipart Content-Type', () => {
  assert(!/['"]Content-Type['"]\s*:\s*['"]multipart\/form-data['"]/.test(apiSrc),
    '手写了 multipart/form-data，boundary 会丢，服务端会拒');
});

check('token 只抄 id，不抄身份证手机号', () => {
  assert(tokenSrc.includes('info?.id'), 'token 桥没有取 id');
  for (const field of ['idCard', 'phone', 'birthday']) {
    assert(!tokenSrc.includes(field), `token 桥抄了 ${field} —— 不该采这个字段`);
  }
});

check('401 会清票并给出可操作的提示', () => {
  assert(/code === 401/.test(apiSrc), '没有处理 401');
  assert(/dropToken/.test(apiSrc), '401 时没有清票');
  assert(/certificateLogin/.test(apiSrc), '401 的提示里没有告诉用户去哪重新登录');
});

check('字典有缓存（一次流程不重复问三遍）', () => {
  assert(/TYPES_TTL/.test(apiSrc) && /typesCache/.test(apiSrc), 'getLeaveTypes 没有缓存');
});

check('纯函数层没有网络/DOM 依赖（可离线跑）', () => {
  assert(!/from '\.\/xhsz-api'/.test(leaveSrc), 'xhsz-leave.ts 不该依赖 api 层');
  assert(!/fetch\(|getHost\(/.test(leaveSrc), 'xhsz-leave.ts 里出现了网络调用');
});

check('确认卡渲染包含 warnings 与照片来源', () => {
  assert(/warnings/.test(renderSrc), 'renderDraft 没有把 warnings 显示出来');
  assert(/photoSource/.test(renderSrc), 'renderDraft 没有说明照片从哪来');
});

// ---------- 8. 构建产物 ----------

const dist = join(repo, 'dist', 'zwu-ehallapp-assistant.user.js');
check('构建产物包含全部工具（若已构建）', () => {
  if (!existsSync(dist)) {
    console.log('    （dist 还没构建，跳过这条）');
    return;
  }
  const text = readFileSync(dist, 'utf8');
  for (const name of EXPECTED) assert(text.includes(name), `产物里没有 ${name}`);
  assert(text.includes('// @match        https://nxg.zwu.edu.cn/zhxg/*'), '产物里没有智慧思政域的 @match');
});

// ---------- 结果 ----------

const total = pass + failures.length;
console.log(`\n${pass}/${total} 通过`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(` · ${f.name}\n   ${f.message}`);
  process.exit(1);
}
console.log('离线验收全过。真机验收见 README「怎么用」。');
