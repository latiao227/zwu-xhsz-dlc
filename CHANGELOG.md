# Changelog

## 0.6.1 — 2026-11-07

实机审计 17 个工具，修 7 个问题。

**修复**
- `lessons[].remark` 被塞了节次号（站点会把它当备注显示给辅导员）→ remark 恒空，节次只用于确认卡展示
- `draftStillValid` 在 500 时误报 false（模型会误以为草稿作废要重出）→ 改成「没成功且没作废」即为 true
- 通用草稿没有失败次数上限 → 同一个草稿最多试 3 次
- `checkPayload` 对「未声明字段」的 action 放行一切 → 没声明字段一律拒
- 白名单里 `/s/laterSaoSubmit` 重复两次 → 去重
- `xhsz_form_draft` 的下一步文案写成「把这条**提交**发出去」→ 改用 action 中文名
- `audit=3` 列表状态列全是「—」→ 按口径显示「历史/驳回」

## 0.6.0 — 2026-11-07

**新增：通用受控写执行器**（覆盖长尾，让学生事务都能走 AI）

- `xhsz_form_actions` / `xhsz_form_draft` / `xhsz_form_submit`
- 36 条学生端写接口白名单，每条声明允许的字段
- 三重闸门：action 白名单、字段白名单、两步确认
- 实测：越界字段被拒、教师端接口被拒、合法字段出确认卡并自动补 `studentId`

## 0.5.0 — 2026-11-07

**新增**
- `xhsz_leave_resubmit_draft` / `xhsz_leave_resubmit`：驳回后重提（覆盖原单）
- `xhsz_workaid_opinion_draft` / `xhsz_workaid_opinion`：勤工助学月度意见
- `xhsz_workaid_withdraw_draft` / `xhsz_workaid_withdraw`：撤回岗位报名
- `xhsz_guide`：11 张引导卡（多步向导 / 扫码 / 签字 / 外链）

## 0.4.0 — 2026-11-07

**新增**
- `xhsz_leave_guard`：请假影响面（漏哪几节课 + 该课考勤情况）
- 按节次请假自动填 `lessons`：经扩展 service worker 跨域读「上课啦」课表
- `chrome-extension/background.js`：SKL 课表代理（路径 + 动作双白名单）

**修复**
- 字典 `status` 语义写反（`'0'` 是启用，`'1'` 才是停用）
- 「下午3点到5点」被解析成 `03:00-05:00`（12 小时制没换算）

## 0.3.0 — 2026-11-07

**重构：请假从 4~5 轮问答压到 2 句话**

- 新增纯函数层 `xhsz-leave.ts`：时间解析（明天上午/周几/11月8日/8点到12点）、类型推断、冲突检测
- `xhsz_leave_draft` 必填从 8 个砍到 2 个（`when` + `reason`）
- 照片自动复用 VFS 里 24h 内最近的附件图
- `xhsz_leave_submit` 自动回读单号与审批状态；501/502/503 不再作废草稿
- 请假字典加 5 分钟缓存

## 0.1.0 — 2026-11-07

首个可用版本。

- 6 个工具：请假类型 / 草稿 / 提交 / 列表 / 详情 / 销假
- 两道闸：`riskOf→act` 走主仓授权闸门；`draft_id + confirm:true`
- 实机提交成功（单号 1662814，系统自动审批通过）
- 19 条离线断言
