# 自动 Skill 学习收尾核对（2026-09-30）

本核对以 [技术方案](skill-learning-design.md) 的 L0–L4、LI1 为范围。
手动保存补充批次、已有 Skill 接管、撤销、历史版本和组织发布不纳入首版。
当前范围的功能实现与自动化验收已完成，可进入人类体验验收。
按用户 2026-09-30 的调整，开发阶段沿用已有样式，功能回归不再等待样式确认；
样式细节留在人类验收阶段调整。这不表示人类体验验收已经通过。

| 要求 | 当前证据与结论 |
| --- | --- |
| 完成 Run 后自动生成、更新受管个人 Skill，并供后续 Run 使用 | 隔离 Docker `automatic-flow.test.mjs` 已通过；最新清理故障回归同时覆盖这一主链路 |
| 策略、预算、来源分级、按需读取及并发准入 | 所属服务测试与既有隔离故障用例已有证据，汇总见 [当前状态](current-status.md)；不是新增服务的交付 |
| 预设只读、不接管已有个人 Skill、不提供撤销 | 当前合同及解析器保留空 `adopted_paths`；共享合同 15 项通过；本轮没有增加内容快照或历史版本 |
| 候选校验、原子安装及未知效果恢复 | Runtime 门禁和 ACP 真实安装竞争用例已有证据；不能以未知效果宣称应用成功 |
| 前景优先、模型忽略取消 | ACP 已停止等待纯模型响应，晚到成功/错误不形成候选，未知费用保留。1008 项单元、类型/lint 及 Docker `antnest-lifecycle-05fe7d09` 抢占回归通过；该项目无残留容器。文件副作用未结仍需有界观察，不宣称任何故障都不影响前景 |
| 模型故障恢复后继续学习 | Docker `antnest-lifecycle-cef1dc9b` 通过：复盘 503 后普通前景 Run 仍成功；模型恢复后新来源自动创建、发送 notice，并由后续 Run 真实读取。旧来源仍为 completed，旧任务及未知调用/费用预约保持不变，不重发旧请求。专属容器、网络和卷均无残留；未修改生产恢复逻辑 |
| 前景文件工具调用习惯 | [工具优化](runtime-tool-usability-20260930.md) 通过 Runtime/ACP 门禁；Docker `antnest-lifecycle-e5c9b393` 两轮真实 write/edit/read/bash 均成功并正常结束，继续完成个人 Skill 创建/更新、SDK notice 恢复、ACP 重启后读取与学习 Trace 检查。开发验收 Agent 已正常重建并核对原 Skill 内容。原 DeepSeek 演示保留历史失败记录，未额外进行付费推理 |
| 已结算候选清理与应答丢失恢复 | 已通过：1002 项 ACP 单元、309 项 PostgreSQL、14 项合同及最终 Docker 清理故障回归；前代候选、五秒超时与前景交接已覆盖 |
| SDK notice、Bridge 补读、View/SSE 与 FE 去重 | 后端/组件及隔离恢复证据已有；本轮真实浏览器验证实时结果、刷新无旧 toast、历史去重与手机恢复，通过 |
| L4 来源跳转 | 144 项前端组件与类型/构建门禁通过；Docker 浏览器 `antnest-lifecycle-b641ef81` 从实际页面发送创建/更新/读取消息，并从新对话跳回真实来源 Session。桌面及手机结果恢复通过 |
| L4 阻塞原因和处理指引 | 最小 `learning_status` 合同及 ACP GET 生产者已交付；310 项 PostgreSQL、15 项合同及最新1008项 ACP 单元门禁通过。UI 的253项 Node、13项客户端及SDK HTTP组件测试通过。真实 HTTP 投影和本轮144项前端组件通过；Docker 浏览器 `antnest-lifecycle-f86da5cd` 验证仅打开结果时读取历史复盘诊断、聊天仍可用、恢复后新来源学习与提示、来源跳转及桌面/手机刷新。普通 View/SSE 不轮询，不提供任务管理/kill 接口 |
| 密钥泄露隔离与旧备份恢复限制 | 人工处置路径 Docker 回归已通过 `antnest-lifecycle-706dabfe`：停止签发不等于撤销，停用实际 Runtime 后入口不可达；受保护 RC dump 恢复副本保留冻结快照并保持离线，新 Enable 拒绝旧钥且保留 Skill 使用。该备份没有在途操作，不证明在途旧目标的泄露恢复，也不提供自动撤销。未结目标仍需人工按事实结算 |
| 浏览器及部署体验 | 现有 Playwright/Chromium 路径通过5项基础浏览器集成和2项真实隔离 Docker 浏览器 E2E；生产 client/SSR 构建与类型检查通过。两套专属容器、网络、卷及 Playwright 子进程均无残留。人类体验验收及样式细调尚未进行 |

本轮清理证据位于私有目录：

- `artifacts/verification/skill-learning/antnest-lifecycle-2742a8ab.json`：两次释放，注入应答丢失，候选和删除临时目录为零，活动 Skill 保留。
- `artifacts/verification/dependencies/acp-1790706285-4080.*`：309 项 PostgreSQL 测试和资源清理记录。
- `artifacts/verification/skill-learning/acp-cleanup-final-local.log`：1002 项单元与14项共享合同测试。
- `artifacts/verification/skill-learning/antnest-lifecycle-cef1dc9b.model-recovery.json` 与 `model-recovery-current-images.log`：模型故障、前景继续、恢复后新来源学习及旧请求不重发。
- `artifacts/verification/skill-learning/antnest-lifecycle-5e806686.json` 与 `model-recovery-fixture-regression.log`：共用模型夹具修改后的正常创建、更新、实时 notice、补读及后续真实读取回归通过。
- `artifacts/verification/skill-learning/model-recovery-resource-cleanup.json`：上述两项目按 Compose 和 RC 标签核验，容器、网络和卷均为零。
- `artifacts/verification/skill-learning/antnest-lifecycle-c0386f4f.model-recovery.json` 与 `model-recovery-diagnostic-integration.log`：在模型恢复主路径上加入真实按需诊断 HTTP 投影验收；该项目同样无容器、网络或卷残留。
- `artifacts/verification/skill-learning/ui-functional-components.log`：19 个文件、144 项前端组件通过，包含新增诊断行为。
- `artifacts/verification/skill-learning/ui-functional-browser.log`：生产构建、类型检查及5项 Chromium HTTP/SSE、会话切换和 SSR 集成通过。
- `artifacts/verification/skill-learning/antnest-lifecycle-b641ef81.json` 与 `automatic-browser-functional.log`：真实页面自动创建/更新/使用、来源跳转、结果提示、刷新/手机恢复通过；候选仍通过 Registry 包校验。
- `artifacts/verification/skill-learning/antnest-lifecycle-f86da5cd.model-recovery-browser.json` 与 `diagnostics-browser-functional.log`：真实页面按需诊断、模型故障期间聊天、恢复后新来源学习、来源/刷新/手机恢复通过；旧任务及未知模型调用未重发。
- `artifacts/verification/skill-learning/browser-functional-resource-cleanup.json`：两项目按 Compose 和 RC 标签核验，容器、网络和卷均为零；Playwright 子进程为零。各项目的 `.browser/` 目录保留桌面/手机截图。

此表记录当前首版的实际行为证据及其边界，不把样式预览当成功能验收，也不把确定性模型夹具的通过当成所有真实任务的学习质量证明。

已通过的功能回归入口：

- Agent UI 的 `npm run test:components` 与 `npm run test:browser`，包括新增诊断组件行为。
- 根目录 `make e2e-skill-learning-browser`：真实页面发送 → 自动创建/更新 → 结果提示 → 来源跳转 → 刷新/手机恢复。
- 根目录 `make e2e-skill-learning-diagnostics-browser`：真实故障诊断按需读取 → 聊天可用 → 恢复后提示 → 来源/刷新/手机恢复。

浏览器模块在根 `tests/e2e/skill-learning/browser-learning.mjs`，由协调进程统一
关闭浏览器再清理 Docker；默认后端回归不加载或启动它。L0–L4、LI1 当前范围的
功能门禁已通过，剩余步骤为人类体验验收；人工保存、接管、撤销、历史版本和
组织发布仍在首版范围之外。
