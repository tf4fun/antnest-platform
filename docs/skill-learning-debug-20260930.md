# 真实模型 Skill 学习失败与 Trace 排查（2026-09-30）

范围为全新验收环境中的 `Acceptance Demo Agent`，使用直接 DeepSeek
`deepseek-flash`。本记录区分实际失败证据、代码缺口与尚未证实的原因。
它不将模拟模型回归的成功视为真实模型学习质量的证明。

## 系统内强制学习 debug

按用户后续澄清，调试应保证完成的 Run 进入实际学习流程，并要求模型尝试
生成；不是另建一套手动模型重放脚本。ACP 现在提供开发部署设置
`ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID`，默认不设置，限定一个 Agent。
该 Agent 新扫描的 completed Run 无须满足经验线索，按原队列进入复盘；任务
冻结 `review_prompt_version=2`，不受十分钟复盘冷却阻挡。前景优先、十五秒
空闲宽限、授权、策略、费用上限及候选/安装检查仍使用正常实现。

版本 2 提示要求模型返回最小、有真实证据引用的 `propose`。若模型仍给出
`skip`，校验报告 `debug_skip` 并使用原有的一次修复预算；不会将 skip 伪造
为成功 Skill。后续候选生成、Runtime prepare/check/commit、持久变更和 SDK
notice 均由现有执行器完成。Trace 增加 `antnest.learning.debug` 和
`antnest.learning.review_prompt_version`，仍不导出凭证或模型正文。

debug 标记随任务保存，暂停恢复和候选清理读取相同的冻结版本；移除部署设置
后新任务恢复普通版本 1，已创建任务不被重新解释。开启开关也不清空旧来源
判定、付费调用或失败记录。用户界面继续用正常聊天触发新 Run，没有新增
任务管理页、学习工具或独立学习服务。

专项入口为 `make e2e-skill-learning-debug`：单工具轮次完成 Run → 拒绝模型
skip → 一次修复 → 创建/更新 → 真实通知 → 移除 debug 并重启 ACP → 后续
Run 读取两条已安装规则；Trace 核验两次生成及 Runtime 维护父子关系。
本轮 ACP 全量单测 1023 项、合同 15 项、HTTP 组件 2 项、PostgreSQL 组件
64 项及 Docker debug 门禁均通过。最终隔离项目为
`antnest-lifecycle-8aad6da7`：创建/更新 Trace 分别有 204/195 个 span，均包含
首次 `debug_skip`、第二次提案校验成功、Runtime 安装及应用结果。未修改测试
冷却时间，后续读取在移除 debug 并重启 ACP 后通过。

Docker 首轮 `antnest-lifecycle-f348e0c2` 在模型调用前遇到重启后的
`configuration_not_ready`；补齐明确的 Controller 配置同步等待后重跑通过。
两轮专属容器、网络与卷已核验清零，证据在
`artifacts/verification/human-acceptance-20260930/demo/debug-learning/`。

已将通过门禁的 ACP 镜像同步到真实验收环境。首次尝试在受控 Chrome 发送
文件创建/读回任务时被自动审批拒绝：此前授权限定一轮真实复现，不包括额外
的强制 debug Run、会话上下文/工具结果外发及模型费用。该点击未执行，也
未产生 Run 或付费调用；当时已移除临时 debug 设置。随后用户明确要求
“开始演示吧，允许使用 DeepSeek provider”，本次才重新启用开关并通过正常
服务执行下面的一轮演示，没有手动解密 Provider 凭证或重放旧模型调用。

## 真实模型强制学习演示结果

通过正常 Gateway 登录及会话 API 创建空白 Session，在受控 Chrome 中选择
DeepSeek Flash / Thinking Off，发送仅创建 `demo/debug-learning.md` 并读回
核验的任务。真实后台学习已完成，但前景任务未完成要求的 read 核验，两者
必须分别记录，不能将本次演示描述为整条业务任务通过。

- Session：`session_650dc91df8b181bc78c7ff2b3014cacb`。
- 来源 Run：`run_0c9f1566c21f18fbd983f459e247d699`，状态 `completed`，
  停止原因为 `max_turn_requests`，并非正常回答结束。
- 学习任务：`learn_873bbb1f9af7b35452fecf5c7a80fae4`，版本 2，`completed`。
  一次实际后台推理使用 1319 输入 / 542 输出 token，返回 `propose` 并通过校验。
- 个人 Skill：`.antnest/skills/workspace-write-readback-check`，候选为 `applied`。
  Runtime 中的 `SKILL.md` 与持久候选正文逐字一致，包摘要为
  `sha256:ba6e70c6781eb0f97bc8d4b30d3699c10d541f138f350427704d80a49fdd5e22`。
- 持久变更：`8f4e058e-0a45-43d7-a14a-f7a67bdb0558`，依据为正常学习策略。
  Chrome 实际收到“New skill learned”notice，结果数量变为 1，来源跳转指向
  本次 Session；移除 debug 并重启 ACP 后，同一结果通过正常补读恢复。
- [学习 Trace](http://127.0.0.1:16686/trace/f91044ce64c956eb751f3bd178abeed2)：
  173 个 span、ACP 与 Runtime 两个服务，复盘、模型、校验、apply 和三次
  Runtime 维护 HTTP 均已核验父子关系，没有缺失的父 span；未捕获模型正文。

前景 Run 的 39 条过程更新包含 32 个工具失败更新。实际被接纳执行的三次
工具调用均为 bash；其中一次写入演示文件。read 调用将 `path` 传为字符串并
在根层传入 `root`，校验明确返回 `/ must NOT have additional properties`、
`/path must be object`，后续反复失败最终触及模型调用上限。因此，文件存在
由本轮只读检查证实，不能说前景 Agent 已按要求读回并汇报。已安装 Skill
要求读回后才能报告，没有声称本次读回成功。这是新增的前景工具参数问题，
并非学习候选、安装或 notice 失败；本次未额外启动付费模型轮次。

该工具参数问题已由后续 [工具优化批次](runtime-tool-usability-20260930.md)
修复：公开文件路径改为字符串，read 改为可省略范围的按行读取，bash 增加
合理默认值；ACP 的模型上下文、个人 Skill 内部读取、先前 Skill 使用扫描及
工具呈现同步消费新合同。隔离 Docker `antnest-lifecycle-e5c9b393` 的两次
write/edit/read/bash 来源 Run 均正常结束，Skill 创建、更新、notice 恢复、
重启后读取及学习 Trace 检查通过。这不改变上面真实 DeepSeek Run 的历史
失败结论。用户后续要求重新测试后，已另行完成真实 DeepSeek 工具与学习
复测，详情见下面的复测记录。

结果面板中的旧 `review_inconclusive` 提示仍来自历史暂停任务，不属于本次
已完成任务。临时 debug 已关闭，ACP 健康。会话、费用回执、安装正文、原始
Trace、页面截图和关闭开关证据保存于
`artifacts/verification/human-acceptance-20260930/demo/debug-learning/`，不纳入 Git。

## 工具优化后的真实复测

在新的 Session `session_06f6ee46d3a6a63fc9583fa4b578c60f` 中，DeepSeek Flash /
Thinking Off 完成六次工具调用，零失败更新，来源 Run 正常以 `end_turn`
结束。debug 学习任务 `learn_8950372f3e2c780798faf5d2c7b7e0ee` 随后完成，
一次复盘使用 1991 输入 / 591 输出 token，安装
`workspace-write-read-edit-verify`，页面显示新增学习结果和正确来源。
安装正文与持久候选逐字一致，关闭 debug 并重启 ACP 后，结果仍通过正常
Bridge/View 恢复。前景和学习 Trace 分别有 590/182 个 span，父子引用完整。

本轮同时修复一个实际阻塞：历史暂停任务恢复为 running 后抛出异常，恢复
入口只记诊断，未释放持久全局名额，新任务因此一直 pending。task processor
现会在传播未处理异常前持久暂停，使普通认领和暂停恢复两条入口都释放名额。
两项新增回归先失败再通过，ACP 本地门禁和隔离 Docker 失败恢复回归通过。
部署后本次原队列继续完成，没有修改任务状态、重新发送已结算调用或清空
历史费用回执。旧预算耗尽任务的反复恢复仍是下文记录的独立遗留项；本批
没有将旧失败标记为成功。

完整身份、Trace 链接、门禁和私有证据路径见
[工具优化复测记录](runtime-tool-usability-20260930.md#真实模型复测)。

## 已确定的失败位置

两次来源 Run 都完成了实际文件工具调用，达到自动复盘条件。学习任务均已
进入复盘并调用模型，最终为 `paused / review_inconclusive`。失败位于
[LearningReviewRunner](../services/agent-acp-service/src/application/learning-review-runner.ts)
的响应形状检查或提案解析阶段，没有产生通过校验的 decision，尚未进入候选
交付、Runtime 安装或通知发布。因此当前失败不能归因于 Docker Skill 卷或
Agent UI 没有接收 notice。

| 任务                                     | 来源 Run                               | 模式         | 两次实际输出 token | 结论                                                                 |
| ---------------------------------------- | -------------------------------------- | ------------ | ------------------ | -------------------------------------------------------------------- |
| `learn_47e63ea79ffcac52418e06d79d48b580` | `run_73caf42aac3923035689b33f54f8fe15` | 模型默认     | 3000、1000         | 均等于单次上限，可能被截断；旧记录没有 stop reason，不能断言具体原因 |
| `learn_94e2bee14ee328dba90c9d60741daa05` | `run_724d6ab289f76eddaead44de1faa0504` | Thinking Off | 751、679           | 均低于上限，仍未通过校验；不能只用思考预算解释失败                   |

首次任务沿用模型默认配置。用户在前景会话选择 Off 后，复盘使用来源 Run
冻结的 Off 配置；本轮没有另行强制替换学习模型或思考配置。

## 原有 Trace 的实际缺口

Jaeger 已导出四次模型调用，每个 Trace 仅有 `model.complete` 和 HTTP client
两个 span。模型 span 为 root，`model.purpose=response`，没有学习任务身份、
来源 Run 关联、stop reason 或提案校验事件。

- 首次复盘：[第一次调用](http://127.0.0.1:16686/trace/14046ae5cc4e0fdd362a9bdc34b6879d)、[修复格式调用](http://127.0.0.1:16686/trace/8e378a71e67cbeac6b5e7c06c4b1e293)。
- Off 复盘：[第一次调用](http://127.0.0.1:16686/trace/19b1e8798f12c4b66ca18ff47543192d)、[修复格式调用](http://127.0.0.1:16686/trace/187d8481802ce9c397bf1c1fa198fd6c)。

数据库只持久化通过校验的 decision。未通过的输出与具体校验异常被丢弃，
catch 中没有诊断，所以原有 Trace 只能确认模型调用完成，不能回答是 JSON、
字段类型、证据引用还是停止原因不合要求。旧输出无法在本轮事后还原。

## 本轮补充的 ACP 诊断

所属服务为 Agent ACP Service；没有增加共享 API 字段或跨服务行为。

| 阶段              | 新诊断                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 已认领学习任务    | `skill_learning.task` 父 span，记录 Agent、task、generation、source Run 和最终状态                                                   |
| 复盘              | `skill_learning.review`，记录 propose、skip 或 inconclusive，以及证据数量、各来源等级数量、正文总字节数与截取标记                    |
| 每次推理          | `skill_learning.review.call`，与既有 `model.complete`、HTTP client 同属一个学习 Trace；purpose 为 skill_learning                     |
| 结果校验          | `skill_learning.review.validate`，记录接受/拒绝、输出停止原因、内容/思考字节数、输出是否带 Markdown 围栏、有限的 schema 路径与错误码 |
| 安装阶段          | `skill_learning.apply` 归入同一任务父 span；最终 change ID 可回查持久记录                                                            |
| Runtime 维护 HTTP | 修复默认客户端的普通 fetch；复用既有 `tracedFetch`，传播 W3C 上下文，不导出签名凭证或包正文                                          |

JSON、结构和输出截断可以分别定位。其他提案校验失败保留
`invalid_proposal` 分类，不伪称已经确认是哪条证据规则。默认不导出输入、
响应正文、思考正文、包正文或凭证。模型 skip 与前景抢占不被误报为任务错误。

SDK notice、Bridge 补读与 UI SSE 尚无贯通的学习 Trace，不能将本轮 ACP
诊断称为通知到页面的完整 Trace。Runtime 维护 HTTP 的实际父子关系由隔离
Docker Trace 门禁单独核验；它与真实模型学习质量是不同的证据。

## 正常服务复现结果

用户明确授权后，通过正常 Gateway 登录和 Agent UI 会话 API 创建空白
Session，再在受控 Chrome 中选择 Flash/Off，发送读取来源 → 写入报告 →
读回核验的普通任务。没有手动解密 Provider 凭证，没有改写生产冷却时间，
没有重发已结算调用。

- Session：`session_e525a8a944d3b39e083b3620ce6d0a7f`。
- 来源 Run：`run_d9695b30c16a3e302a5bbe3a87f37f2e`，已完成实际文件任务。
- 任务：`learn_b4e6b3a59368caa0c4c7c21dc37b3ecf`，`skipped`。
- 一次推理，2240 输入 / 54 输出 token；`end_turn`，思考正文 0 字节，JSON
  与提案校验通过。模型认为预设 `acceptance-status` 已覆盖同类报告需求，且
  截取证据不足以确认可复用的成功流程，选择合法 `skip`。
- [真实复盘 Trace](http://127.0.0.1:16686/trace/31e7f7b680c74c05995b1c5086b3053e)：
  69 个 span、2 个服务；任务、复盘、模型、HTTP 与校验同属一个 Trace。

这次没有复现原有 `review_inconclusive`，不能据此反推旧两次具体校验错误，
也不能把合法 skip 改报为自动生成成功。源任务完成不等于必然值得创建新 Skill。

核对证据抽取后，当前上限为前 8 次工具尝试、每次输出前 512 字符；本次
保存 1 条用户要求、6 条执行事实、6 条输出片段，`truncated=true`。这能解释
模型为何看到不完整证据，但不能证明截取是旧格式失败的原因。执行事实只
记录工具身份与状态，不包含完整工具参数；首版复盘质量受此边界限制。

重启 ACP 时另遇 Bridge 历史重放错误 `Too many incomplete delivery events`。
旧会话保留，新会话可以使用；这不是旧学习失败所在阶段，本轮不修改 UI/Bridge
实现。结果面板查询仍会显示尚未解决的旧 paused 任务，不能用它推断新任务失败。

## 已发现的格式重试缺口

当前修复格式调用只有原始 system/user 证据和一条“previous response did not
match”提示，没有把上一条模型输出或具体校验失败反馈给模型。它实际上是
对原输入再生成一次，模型无法看到被拒绝的回答。这个代码问题已确认，但
尚不能证明原始两次失败具体违反了哪个字段。补充诊断不改变既有判定、预算
和重试语义；真实失败分类确定后再修复相应行为。

## 已确认的无效恢复循环

[PausedRecovery](../services/agent-acp-service/src/application/learning-paused-recovery.ts)
会对仍为 paused 的旧任务调用 `resumePaused` 和 processor。两项旧任务的模型
调用都已 `settled`，decision 均为空。Runner 重放读取空回执后只能再次返回
inconclusive，因此重复恢复不会改变结果。

07:55 UTC 只读核对时，两个任务的 `updated_at` 都已推进到当时，而四条模型
调用的 `settled_at` 仍分别停在 06:24/06:34，`model_calls` 始终为 2。它不产生
额外付费推理，但产生重复数据库读取/更新及错误 Trace。本轮未改恢复行为。
后续应对“预算已耗尽、无候选、无未结效果”的任务停止重复准入，保留诊断与
原费用回执；不能直接排除仍有待观察效果的所有 paused 任务。

## 验证与后续复现

新增专项单测检查真实 OpenTelemetry 父子关系、失败分类、字段/正文不泄露、
skip 和抢占语义。新增 HTTP 组件测试通过生产模型适配器验证失败字段定位、
一次有界修复、usage 结算和 W3C 传播。最终单元基线 1015 项通过；追加的 Runtime
HTTP 追踪专项及关联单元 31 项通过，类型检查/lint 通过，HTTP Trace 组件 1 项通过。
根入口 `make e2e-skill-learning-trace` 检查真实 Docker 安装、notice 和后续读取，
并从 Jaeger 核验创建/更新的学习父子关系与维护 HTTP。最终 Docker
`antnest-lifecycle-c9a919b6` 通过：创建/更新 Trace 分别为 186/177 个 span，
均有完整任务 → 复盘 → 模型/校验、任务 → apply → 维护 HTTP → Runtime
关系。真实 notice、补读、后续读取及候选 Registry 包规则验收同样通过。
这项回归使用确定性模型夹具，不证明真实模型必然会选择生成 Skill。

第一次 Docker 回归 `antnest-lifecycle-679edc79` 完成业务主链路后，Trace
断言遇到 Jaeger 将 Runtime HTTP 状态码表示为字符串 `"200"`，而测试期望
数字 200。修正测试表示兼容后重跑通过，没有修改业务状态或取消校验。
两轮测试专属容器、网络和卷已核验清零。

保存的 Docker 证据为
`artifacts/verification/skill-learning/antnest-lifecycle-c9a919b6.json` 和
同目录 `.learning-trace.json`；私有诊断目录还包含门禁日志、Trace 摘要和
`docker-resource-cleanup.json`。已将通过该回归的 ACP 镜像同步到验收环境。

原计划的手动模型重放没有执行：自动审批拒绝了直接解密 Provider 凭证并
发送重建证据的动作。随后用户明确授权通过正常服务复现，已按上述路径完成。
没有重试被拒绝的凭证提取方式；旧任务及其已结算调用不重发。

私有证据存放在
`artifacts/verification/human-acceptance-20260930/demo/learning-diagnosis/`，
其中 `original-review-traces.json` 保存四份原始 Trace，
`normal-service-review-traces.json` 保存本次正常复盘的完整 Trace。
