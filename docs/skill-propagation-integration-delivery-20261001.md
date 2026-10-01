# Skill 动态传播：DI1 完整链路验收

2026-10-01：用户确定的四步流程已完成实现与隔离 Docker 集成验收。
自动投影保持动态来源映射，显式提升才创建 Registry 托管的不可变版本；
模板冻结正式版本，创建或显式重建之后才改变 Agent 的预设能力。

本批只增加根 tests 的集成验收与交付文档，没有混改多个服务实现。
服务实现及所属门禁分别见 [Registry D1](skill-discovery-registry-delivery-20261001.md)、
[ACP D2](skill-discovery-acp-delivery-20261001.md)、
[模型工具 D3](skill-discovery-tools-delivery-20261001.md)、
[Runtime D4](skill-discovery-runtime-delivery-20261001.md)、
[ACP D4A](skill-discovery-temporary-consumer-delivery-20261001.md)及
[Console D6](skill-discovery-console-delivery-20261001.md)。
共享规则仍以[发现合同](../contracts/skill-registry/discovery-api.md)和
[四步技术方案](evolver-technical-analysis.md#112-用户确定的四步产品流程)为准。

## 实际验证的业务流程

| 步骤           | 操作与证据                                                                                                    | 所有权                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 自动投影       | A 的正常 Run 自动学习生成个人 Skill，随后自动更新；Registry 仅登记元数据、来源引用和摘要                      | 正文、文件及来源生命周期归 A                             |
| 检索及临时使用 | B 的模型实际调用 find_skill/load_skill，读取 A 的当前学习规则；完整包用例进一步使用真实临时路径执行 read/Bash | 当前 Run 临时使用，不写入个人或系统 Skill                |
| 用户提升       | 实际来源所有者登录，经 Console 浏览器预览并分别新建 v1、追加 v2，两者内容摘要不同                             | 完整包、不可变版本及发布回执归 Registry                  |
| 预设分发       | 固定 v1 的模板创建 C；正式发布 v2 后 C 仍使用 v1；模板新修订固定 v2，显式重建 B、C 后两者才取得 v2            | Controller 冻结配置；RC 准备实际文件卷；Runtime 只读使用 |

首版自动学习生成的是单文件 SKILL.md，因此 A → B 的来源临时使用验证的是
D3 的正文路径。同一部署中的多文件包用例验证 D4A 的真实文件交付、read/Bash
及回收；它采用正常上传的合成正式包，未声称自动学习已经会生成多文件包。
预设卷保存实际下载文件，`/skills` 的 Docker named-volume 挂载为只读，
并核对卷标签、完整集合清单、正式版本摘要与 SKILL.md 摘要。

## 权限、故障与冻结

使用真实 Identity/Gateway 会话，不模拟浏览器请求、来源读取或发布身份。
普通成员不能发布；同组织的另一名管理员也不能冒充来源所有者。验收通过既有
Directory 管理入口授予合成来源所有者管理员角色，再重新登录并执行提升。
产品发布权限没有放宽。

Registry 停机期间，A 的第二次学习仍生效，C 的既有 v1 预设 Run 仍完成。
ACP 正常重启、Registry 恢复后，持久投影重新送达。B 的临时包分别覆盖完成、
取消、正常 ACP 重启中断及之后新 Run 准入；三个临时范围均确认释放，
个人目录和系统目录没有新增临时包。重启中断 Run 按既有合同终止，未计为成功 Run。

发布 v2 不修改历史模板、当前 Agent 或已安装 v1。两次显式重建使用不同 Agent
的独立卷。之后向 A 的实际来源目录增加文件，旧选择因完整包摘要变化而被拒，
映射失效事件送达；正式 v1/v2 仍能独立下载，历史模板仍固定 v1，C 的 v2 仍可执行。
没有引入 Run 中持续内容监听、撤销、历史业务资产迁移或新服务。

## 验证结果

复现入口：`make e2e-skill-propagation`，源码位于
[automatic-flow.test.mjs](../tests/e2e/skill-learning/automatic-flow.test.mjs)及
[propagation-flow.mjs](../tests/e2e/skill-learning/propagation-flow.mjs)。
测试源、共享合同样例及证据均不放在 `.cache/`。

| 门禁                                   | 结果                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 模型夹具单元检查                       | 6 项通过，包括真实内容校验、错误/旧内容拒绝、六阶段重复请求保护                                                |
| 学习、发现、临时交付、Console 共享合同 | 28 项通过，无跳过                                                                                              |
| DI1 Docker 全链路                      | `antnest-lifecycle-d335d044` 通过，约 234 秒，9 组业务检查                                                     |
| 预设实际 Run                           | 6 个完成，数据库快照匹配当前 Agent 修订，旧正文提示通道为空                                                    |
| Trace                                  | 两次真实自动学习、模型发现、6 次 Native install/release 和 6 个预设 Run；核对所属父链、来源/摘要及关闭正文捕获 |
| 浏览器                                 | 真实 Console 提升及 Agent UI 发送/结果，零页面错误、零浏览器 WebSocket                                         |
| 资源                                   | 浏览器关闭、7 个本批候选镜像删除；容器、网络、卷的前后清单完全相同                                             |

不增加全局 NTP 门禁；按既有决定，Trace 校验业务身份及完整父链，不将物理
时钟告警等同于业务失败。本批模型为本地确定性 Provider，经正常服务适配器调用，
没有付费推理、手工解密或重放用户凭证。真人使用体验与真实模型自主判断效果
不由确定性回归替代。

前三次 Docker 失败都保留：成功提示精确匹配短句、Session 校验沿用旧 UUID、
测试模型误将不同阶段的预设核验判为重复请求。已修正测试假设并补充先失败后
通过的阶段唯一性检查，没有跳过用例或放宽模型重复请求防护。最终模型拒绝记录为空。

私有证据：`artifacts/verification/skill-propagation-di1-20261001/`，最终门禁
索引为 `admission.json`；完整组合报告同时保存在
`artifacts/verification/skill-learning/antnest-lifecycle-d335d044.json`。
六个预设 Run 的原始 Trace、浏览器截图及清理清单保存在本批项目子目录。
四次项目均恢复原有 17 个停止容器、0 个运行容器、15 个网络、11 个卷；
旧验收环境没有重新启动。证据排除在 Git 和 Docker 构建上下文之外。

## 完成边界

DI1 已证明上述四步组合业务流程。D5、D7 是技术方案的条件适配批次，本次没有
发现必须新增的 Controller 配置或 Agent UI 提示缺口，沿用现有冻结模板、工具
过程和学习通知。未宣称整个仓库所有阶段均通过当前 HEAD 的全面回归。
Channel Manager、Task Scheduler 不属于本次 Skill Registry 工作。

## 方案逐项核对（2026-10-01）

本次按第 11 节的产品要求与完成标准核对实际测试及原始结果，不以一条成功
路径替代故障、权限或回收证据。当前学习、发现、临时交付及 Console 共享合同
合并检查为 29 项通过、零跳过；记录位于
`artifacts/verification/skill-propagation-requirements-20261001/`。

| 要求                                                          | 所属测试与实际集成证据                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 投影只有元数据，更新有序、旧更新不能恢复墓碑，发送失败可恢复  | [Registry 顺序/不存包测试](../services/skill-registry/internal/registry/discovery_test.go)、[PostgreSQL 组件](../tests/integration/go/skill-registry/internal/registry/discovery_postgres_integration_test.go)、[ACP 持久重试测试](../services/agent-acp-service/test/application/skill-projection-worker.test.ts)；DI1 验证 Registry 停机时学习仍生效、恢复后补发                                                                            |
| 当前所有者权限、撤权及正常来源生命周期                        | [Run 权威组件](../tests/integration/agent-acp-service/adapters/postgres/skill-discovery-authority.postgres.test.ts)、[投影撤权测试](../services/agent-acp-service/test/application/skill-projection-worker.test.ts)；[DI2](skill-source-lifecycle-delivery-20261001.md) 使用普通 Disable/Enable/Delete 验证不可用、恢复及删除墓碑                                                                                                             |
| 按选定摘要获取当前内容，拒绝漂移，无个人包离线副本            | [Registry 加载/漂移测试](../services/skill-registry/internal/registry/discovery_test.go)及来源 HTTP/数据库门禁；DI1 在真实来源目录新增文件后拒绝旧选择，正式包仍独立下载                                                                                                                                                                                                                                                                      |
| 模型输入不能选择组织、用户或调用方，失败尝试也计预算          | [模型输入合同](../services/agent-acp-service/test/domain/skill-discovery.test.ts)、[权限测试](../services/agent-acp-service/test/application/skill-discovery-authorization.test.ts)、[持久 8/4 次预算组件](../tests/integration/agent-acp-service/adapters/postgres/skill-discovery-authority.postgres.test.ts)；[DI3](skill-discovery-caller-integration-delivery-20261001.md) 实际活动 Run 精确加载自身正式版本及另一来源，排除自身个人映射 |
| 临时真实文件只归当前 Run，完成/取消/重启后回收，保护后续准入  | [Runtime 实际文件/禁链接/配额测试](../runtimes/antnest-runtime/src/skill_temporary_tests.rs)、[ACP 回收组件](../tests/integration/agent-acp-service/adapters/postgres/temporary-skills.postgres.test.ts)；[D4A](skill-discovery-temporary-consumer-delivery-20261001.md) 和 DI1/DI3 验证 read/Bash、三个回收场景与后续 Run                                                                                                                    |
| 用户显式提升、角色与来源权限分别检查、幂等版本独立            | [Console D6](skill-discovery-console-delivery-20261001.md) 的 HTTP/桌面/手机门禁覆盖拒绝、重新审阅、创建/追加及来源离线后的回执重放；DI1 经真实登录提升两个不同正式版本                                                                                                                                                                                                                                                                       |
| 模板固定正式版本，发布不热更新 Agent，创建/rebuild 后只读交付 | 本批真实模板冻结、创建、两 Agent 显式 rebuild 与六个预设 Run；Registry 停机及来源变化后，既有预设继续可用，历史模板仍固定旧版本                                                                                                                                                                                                                                                                                                               |
| Trace 来源、摘要及直接父链完整，不捕获查询、正文或凭据        | [D1T](skill-registry-trace-delivery-20261001.md) 的原生 HTTP/OTLP 组件及 [DI3](skill-discovery-caller-integration-delivery-20261001.md) 的 307-span 实际链路；仅接受已有时钟策略允许的纯时间告警                                                                                                                                                                                                                                              |

各所属单元、合同、组件和适用 Docker 结果仍保持原批次范围。早期交付记录
中的待消费者事项由后续 D4A/D6/DI1/DI2/DI3 承接，不改写历史门禁为完整流程。
D5/D7 未产生额外配置或界面需求，继续沿用已验证的 Controller 所有权、固定
模板与 Agent UI 工具过程/学习通知。人类体验和真实模型自主选择效果仍需独立
验收，本次核对没有启动旧环境、调用真实 Provider 或提交 Git。
