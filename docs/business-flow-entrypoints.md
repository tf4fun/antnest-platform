# 业务流程入口总索引

> 更新日期：2026-09-13
> 状态：基于当前实现的入口盘点，供后续逐流程展开与 Jaeger 核对。
> 范围：`antnest-platform` 已开发服务，Docker 单节点。

本文以用户或运维人员的实际目标列举业务流程，不将 API 目录当作业务场景目录。
各流程文档再展开经过的服务、接口、数据交换和时序。
编号用于后续关联流程文档，不代表该流程已完成新一轮链路验收。
现有时序见 [business-sequences.md](business-sequences.md)，此前验收见
[单节点验证报告](docker-single-node-verification-report.md)。

部署、登录、Provider、模板及五类 Agent 生命周期的最新集中评审见
[基于 Trace 的主流程时序与技术评审](business-flow-trace-review.md)。该文档区分
实际观测、源码解释与缺失证据，包含事务计数和待精简点，不改变本索引的验收状态。

## 1. 入口口径

- 以用户有明确目的的动作开始，以可观察的业务结果结束。例如登录应到账号与首页数据完整显示，
  创建 Agent 应到页面显示最终构建结果；登录 200 或创建请求 202 都只是中间步骤。
- 自动身份查询、配置默认值加载、进度订阅、重试等归入所服务的业务流程，不各算一条业务。
  刷新页面后的身份确认与数据重载是原页面流程的连续性验证，不另造“会话恢复”场景。
- 一个用户流程可以包含多个独立 HTTP 请求和多条 Trace。记录同一动作下的完整请求集合，
  不强行合成根 Span，也不只选一条接口 Trace 冒充端到端成功；异步请求仍需追踪到终态呈现。
- **入口服务**是首次接收该操作的服务，不等于业务数据所有者。浏览器和外部身份协议的入口均为 `edge-gateway`；Console 页面发起不代表绕过 Gateway。
- 内部 RPC、后台续办和运维入口单独标明，不暗示已经有公开 API 或管理页面。
- ACP v1/v2、HTTP/WebSocket 是同一业务的协议变体，不重复编号；后续接口核对需要分别覆盖适用变体。
- 暂缓 Web UI 的页面交互验收，但保留它消费的 Gateway/ACP 服务端业务入口。未启动的 Skill Registry、Channel Gateway、Scheduler，以及 K8s、HA/横向扩展不纳入。

### 当前优先核对顺序

按场景独立执行；每完成一项提供其 Jaeger 地址并等待用户检查，再进入下一项。

**新镜像复验已重新开始。** BF-OPS-02 的就绪/首页入口已获用户确认；
BF-AUTH-01 的真实浏览器登录、概览加载与刷新流程已获用户确认；
BF-CAT-02 已在 9 月 13 日的精简存储新镜像上完成真实表单创建、模型展示及刷新持久化核对，
11 条请求 Trace 完整；创建为 22 Span、5 次 INSERT，用户已确认。
BF-CAT-06 已完成浏览器创建、详情与刷新核对，15 条请求 Trace 完整，创建为 18 Span、3 次 INSERT，
用户已确认。BF-AGENT-04 已真实创建 Agent，页面与数据库为 available，Runtime 健康；
主 Trace 181 Span / 7 服务，正常创建场景已获用户确认。事件流取消/租期的观测噪声及发布竞态候选单独保留，
不宣称所有异常路径通过。重建及后续场景尚未重跑。最新进度以
[新镜像逐场景复验](business-flow-trace-review.md#18-新镜像逐场景复验2026-09-12)为准。
下表及其计数保留上一轮基线，不作为本轮完成状态。

Provider 验收讨论形成了 [凭证与模型分离方案](provider-credentials-and-models.md)。
BF-CAT-02 已按新连接/模型合同重新核对管理链路，见
[Provider 连接场景](business-flow-provider-connection.md)；旧 Model Profile 记录仅作历史。
本轮仅重置 Controller 自有 schema，新建连接和三个模型保留供后续模板使用。
连接采用合成测试凭证，不能直接调用 DeepSeek；真实模型调用前必须替换凭证。
按用户要求暂不修改 ACP，先逐项验证管理流程；ACP 执行兼容性不作为已通过结论。

| 顺序     | 入口                         | 上一轮基线（本轮状态见上文）                                           |
| -------- | ---------------------------- | ---------------------------------------------------------------------- |
| 1        | BF-OPS-01 部署流程           | [部署场景记录](business-flow-deployment.md)，用户已确认，允许推进登录 |
| 2        | BF-AUTH-01 管理员本地登录    | [登录场景记录](business-flow-local-admin-login.md)，用户已确认最新链路 |
| 模板前置 | BF-CAT-02 创建 Provider 连接与模型 | 上一轮通过管理 API 建立连接与模型；[场景记录](business-flow-provider-connection.md)现已更新为本轮真实浏览器证据，未调用外部模型 |
| 3        | BF-CAT-06 模板创建 | [模板场景](business-flow-template-create.md)：仅保存原始镜像引用；最终 Gateway 复验见该文档 |
| 4 | BF-AGENT-04 创建 Agent | 原基线 181 Span；[场景文档](business-flow-agent-create.md)已替换为本轮真实浏览器、资源与 Trace 证据 |
| 5 | BF-AGENT-05 显式重建 Agent | [当前单业务 Trace](business-flow-agent-rebuild.md)：239 Span，统一 Temporal 执行，技术验收通过，等待人工审阅 |
| 6 | BF-AGENT-06 停用 Agent | [当前单业务 Trace](business-flow-agent-disable.md)：165 Span，统一 Temporal 执行，技术验收通过，等待人工审阅 |
| 7 | BF-AGENT-07 启用 Agent | [当前单业务 Trace](business-flow-agent-enable.md)：196 Span，统一 Temporal 执行，技术验收通过，等待人工审阅 |
| 8 | BF-AGENT-08 删除 Agent 与资源回收 | [当前单业务 Trace](business-flow-agent-delete.md)：176 Span，统一 Temporal 执行，技术验收通过，等待人工审阅 |

上一轮 BF-AGENT-04..08 已按同一 Gateway Trace 内的完整父子结构核对，不再以旧的
26 条分散 Trace 作为通过依据。五条基线 Trace 全部通过 SDK 阶段、具体成功 RPC、
SQL 归属和零 warning 检查；测试 Agent 及独占运行资源已经回收。
完整实现、测试数据和链接见 [Lifecycle workflows](../services/agent-controller/docs/lifecycle-workflows.md)。
上一轮基线没有执行 ACP Run 或新增浏览器验收，不扩大为所有异常场景和全部产品流程均已验收。

## 2. 登录与个人账号

发起方：管理员或普通用户的浏览器。入口服务：`edge-gateway`。
管理员和普通用户共用本地认证接口，分别保留场景以检查登录后的权限边界。

| 编号       | 流程入口                                       |
| ---------- | ---------------------------------------------- |
| BF-AUTH-01 | 管理员本地账号登录                             |
| BF-AUTH-02 | 普通用户本地账号登录                           |
| BF-AUTH-04 | OIDC 登录，包含发起授权与外部 IdP 回调两个入口 |
| BF-AUTH-06 | 退出登录                                       |
| BF-AUTH-07 | 管理员查看当前账号信息和可用账号操作           |
| BF-AUTH-08 | 管理员修改本人的本地登录密码                   |

BF-AUTH-03（登录方式发现）、BF-AUTH-05（当前身份查询）原编号停止作为独立场景使用，
归入登录与页面加载的自动步骤。保留其接口覆盖，不重新编号其他业务。
本地/OIDC 登录均应包含登录后落地页，刷新与重新打开页面作为该页的连续性验证。

## 3. 用户与组织管理

管理员页面入口服务为 `edge-gateway`。仅内部 RPC 的操作不视为 Console 已提供的功能。

| 编号      | 流程入口                         | 发起方式 / 入口服务               |
| --------- | -------------------------------- | --------------------------------- |
| BF-DIR-01 | 查看组织用户、成员关系和群组目录 | 管理员页面 / `edge-gateway`       |
| BF-DIR-02 | 创建本地用户及组织成员关系       | 管理员页面 / `edge-gateway`       |
| BF-DIR-03 | 修改组织成员资料或角色           | 管理员页面 / `edge-gateway`       |
| BF-DIR-04 | 停用或恢复组织成员关系           | 管理员页面 / `edge-gateway`       |
| BF-DIR-05 | 停用或恢复全局用户               | 系统管理员页面 / `edge-gateway`   |
| BF-DIR-06 | 创建组织及其初始所有者关系       | 可信内部调用 / `identity-service` |
| BF-DIR-07 | 将已有用户加入组织               | 可信内部调用 / `identity-service` |

## 4. 企业身份接入与同步

入口服务：`edge-gateway`。配置管理由管理员发起；SCIM 操作由企业目录系统发起。
OIDC 登录本身归入 BF-AUTH-04，不重复列为配置操作。

| 编号      | 流程入口                              | 发起方       |
| --------- | ------------------------------------- | ------------ |
| BF-IDP-01 | 查看 OIDC 提供者配置                  | 管理员       |
| BF-IDP-02 | 新增或修订 OIDC 提供者配置            | 系统管理员   |
| BF-IDP-03 | 启用或停用 OIDC 提供者                | 系统管理员   |
| BF-IDP-04 | 查看 SCIM 接入凭证列表                | 管理员       |
| BF-IDP-05 | 签发 SCIM 接入凭证                    | 管理员       |
| BF-IDP-06 | 撤销 SCIM 接入凭证                    | 管理员       |
| BF-IDP-07 | SCIM 协议能力、资源类型与 Schema 发现 | 企业目录系统 |
| BF-IDP-08 | SCIM 用户查询，包含列表、筛选与详情   | 企业目录系统 |
| BF-IDP-09 | SCIM 用户创建或删除后的重新预配       | 企业目录系统 |
| BF-IDP-10 | SCIM 用户资料全量替换或局部更新       | 企业目录系统 |
| BF-IDP-11 | SCIM 用户停用或恢复                   | 企业目录系统 |
| BF-IDP-12 | SCIM 用户删除                         | 企业目录系统 |
| BF-IDP-13 | SCIM 群组查询，包含列表、筛选与详情   | 企业目录系统 |
| BF-IDP-14 | SCIM 群组创建                         | 企业目录系统 |
| BF-IDP-15 | SCIM 群组资料及成员集合替换或局部更新 | 企业目录系统 |
| BF-IDP-16 | SCIM 群组删除                         | 企业目录系统 |

## 5. 模型与模板配置

发起方：管理员页面。入口服务：`edge-gateway`。
更新 Model Profile 当前配置包含模型能力与价格，不保留独立模型历史；连接凭证独立轮换，不随模型更新复制。
修订模板包含系统提示、Runtime 镜像/资源及平台托管 stdio MCP 配置，这些是模板修订流程的输入变体。

| 编号      | 流程入口                                |
| --------- | --------------------------------------- |
| BF-CAT-01 | 查看系统维护的模型目录和模型能力        |
| BF-CAT-02 | 创建组织 Provider 连接与初始模型          |
| BF-CAT-03 | 查看 Model Profile 列表及当前详情       |
| BF-CAT-04 | 更新 Model Profile 当前配置             |
| BF-CAT-06 | 创建 Agent 模板                         |
| BF-CAT-07 | 查看模板列表、详情及历史修订            |
| BF-CAT-08 | 发布模板新修订                          |

Model Profile 停用/删除不属于当前已开放的管理流程；模板发布不等于派生 Agent 自动更新。
应用新模板修订使用 BF-AGENT-05。
原 BF-CAT-05（获取默认值）归入打开模板创建表单的步骤；模板创建从打开页面、选择模型与填写配置，
到保存后可见的模板结果结束，不止于 POST 请求成功。

## 6. Agent 管控

发起方：管理员页面。入口服务：`edge-gateway`。
创建、重建、启停和删除是异步业务；这里只列发起入口，不把后台每个执行阶段重复编号。

| 编号        | 流程入口                                              |
| ----------- | ----------------------------------------------------- |
| BF-AGENT-01 | 查看平台概览及首次配置进度                            |
| BF-AGENT-02 | 查看 Agent 列表，包含显式切换已删除记录视图           |
| BF-AGENT-03 | 查看 Agent 详情、当前状态和配置来源                   |
| BF-AGENT-04 | 从指定模板修订创建 Agent                              |
| BF-AGENT-05 | 显式重建 Agent，包含应用新配置及 Runtime 丢失后的恢复 |
| BF-AGENT-06 | 停用 Agent                                            |
| BF-AGENT-07 | 启用 Agent                                            |
| BF-AGENT-08 | 删除 Agent 并回收其运行资源                           |
| BF-AGENT-10 | 查看 Agent 生命周期事件历史                           |
| BF-AGENT-12 | 查看 Agent 当前网络策略                               |
| BF-AGENT-13 | 切换 Agent 公网访问策略，放行或阻断                   |

原 BF-AGENT-09/11 是生命周期操作及详情页的进度/事件交互步骤，不另算用户业务。
创建、重建、启停、删除均包含进度显示和终态；关闭重进或断线恢复作为同一流程的连续性分支。
查询当前网络策略是网络设置页面的内容；切换成功须以最终生效状态呈现为终点。

## 7. Agent 使用与 ACP 会话

发起方：受控客户端。入口服务：`edge-gateway`，不要求由 Web UI 页面执行。
内部可信 ACP 客户端可从 `agent-acp-service` 接入，但不能用内部直连证据替代 Gateway 链路验证。
本节只盘点已实现的协议范围，不宣称通用 ACP 完全符合性。

| 编号      | 流程入口                                                                   |
| --------- | -------------------------------------------------------------------------- |
| BF-ACP-01 | 获取当前用户可访问的 Agent 和使用入口信息                                  |
| BF-ACP-05 | 新建对话 Session                                                           |
| BF-ACP-06 | 查询对话 Session 列表                                                      |
| BF-ACP-07 | 加载或恢复已有 Session，读取历史与当前配置                                 |
| BF-ACP-08 | 从已有 Session 创建分支                                                    |
| BF-ACP-10 | 删除 Session                                                               |
| BF-ACP-11 | 发送对话请求并接收执行结果，包含文本、图片、音频、PDF 和嵌入内容的适用变体 |
| BF-ACP-12 | 取消当前对话执行                                                           |
| BF-ACP-13 | 切换 Session 使用的组织模型，或恢复 Agent 默认模型                         |
| BF-ACP-14 | 切换 Session 工具授权模式，或恢复 Agent 默认模式                           |
| BF-ACP-15 | 回应工具执行审批，包含单次决定、会话内持续规则和重连后继续回应             |
| BF-ACP-16 | 请求对话内帮助，包含 `/help` 与 `/帮助`                                    |

流式回复、思考内容、工具进度、文件差异、计划、用量和费用通知是以上流程的输出，
不是额外的客户端业务入口。多模态输入受模型能力约束；客户端 MCP 注入仍不在支持范围。
原 BF-ACP-02/03/04/09/17 属于进入对话、发送消息或离开页面时的协议步骤，不作为独立业务计数；
对应协议测试仍保留。用户主动打开一段历史对话（BF-ACP-07）有独立目的，
与刷新管理页面自动确认登录身份不同。

## 8. 执行内步骤（非独立业务场景）

这些入口从 BF-ACP-11 的执行内部触发，不另计为用户可以直接启动的独立业务。
单独列出是为了后续展开工具、上下文和网络链路时不遗漏。

| 编号       | 子流程入口                                                                | 发起位置 / 入口服务                              |
| ---------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| BF-EXEC-01 | 获取 Runtime 信息与工具目录，构建环境、AGENTS.md、Skill 摘要和 MCP 上下文 | Run 准备 / `agent-acp-service`                   |
| BF-EXEC-02 | 调用模型并处理流式输出                                                    | 模型执行轮次 / `agent-acp-service`               |
| BF-EXEC-03 | 执行 Runtime 内置工具，包含 read、write、edit、bash                       | ACP 工具调度 / `antnest-runtime`                 |
| BF-EXEC-04 | 执行平台配置的托管 stdio MCP 工具                                         | ACP 工具调度 / `antnest-runtime`                 |
| BF-EXEC-05 | 更新结构化执行计划                                                        | 模型请求本地计划工具 / `agent-acp-service`       |
| BF-EXEC-06 | 上下文达到预算边界后压缩并继续执行                                        | 上下文预算检查 / `agent-acp-service`             |
| BF-EXEC-07 | 请求工具执行授权或进行 Smart Approve 判断                                 | 工具执行前检查 / `agent-acp-service`             |
| BF-EXEC-08 | 执行器访问网络，包含 DNS、连接放行与拒绝                                  | Runtime 执行器产生流量 / `runtime-egress` 数据面 |

BF-EXEC-08 不要求逐包 Jaeger 链路。网络策略 RPC 与工具请求可以跟踪，
转发数据面继续使用现有网络结果与聚合指标，不为本次梳理增加逐包 OTLP。

## 9. 内部管理与后台支撑

这类流程不一定有浏览器请求根节点；记录真实发起服务，不人为补造 Gateway 根 span。
本节是支撑链路附录，不以 Worker 续办、事件订阅或启动恢复数量增加用户业务覆盖量。

| 编号      | 流程入口                                  | 发起方式 / 入口服务                                                      |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| BF-SYS-01 | 修改 Agent 默认工具授权行为               | 可信内部 RPC / `agent-controller`，当前无独立 Console 编辑入口           |
| BF-SYS-02 | 查询或订阅组织范围的 Agent 事件           | 可信内部 RPC / `agent-controller`，区别于单 Agent 的 Console 入口        |
| BF-SYS-03 | 身份撤销后的 Agent 停用联动               | `agent-controller` 消费 Identity 撤销记录；来源为用户或成员关系停用/删除 |
| BF-SYS-04 | 续办已持久化但未完成的 Agent 生命周期操作 | `agent-controller` Temporal SDK Worker 接收引擎分派/重试                        |
| BF-SYS-05 | Runtime 状态变化的观测与 Agent 状态同步   | `runtime-controller` 平台观测，供 `agent-controller` 消费                |
| BF-SYS-06 | ACP 服务恢复后处理未完成 Run 和待审批记录 | `agent-acp-service` 启动恢复，不代表重放工具副作用                       |

身份恢复不会自动启用 Agent，后续显式启用仍使用 BF-AGENT-07。
Runtime 初始化/更新/启停/删除、隧道地址分配/回收、Run 准入/结束等内部 RPC，
是上述 Agent 生命周期与执行流程的组成部分，后续在调用链中展开，不重复当作用户业务。

## 10. 部署与运维入口

运维由操作者、部署平台或服务进程启动，不要求所有行为经过 Gateway。

| 编号      | 流程入口                                           | 发起方式 / 入口                                        |
| --------- | -------------------------------------------------- | ------------------------------------------------------ |
| BF-OPS-01 | 空白实例首次部署，完成各服务初始化与初始管理员引导 | 操作者 / Docker Compose 及各服务启动入口               |
| BF-OPS-02 | 检查平台和服务是否就绪                             | 操作者或平台探针 / Gateway 与各服务状态入口            |
| BF-OPS-03 | 停止或重启服务，完成在途工作处理与资源退出         | 操作者或部署平台 / 各服务进程生命周期入口              |
| BF-OPS-04 | 停服备份服务数据库、必要密钥和 Runtime 持久化卷    | 操作者 / 离线备份流程                                  |
| BF-OPS-05 | 从备份恢复实例并重新开放服务                       | 操作者 / 离线恢复及各服务启动入口                      |
| BF-OPS-06 | 根据业务操作或故障记录定位日志与关联链路           | 管理员或运维人员 / Console 事件信息、服务日志与 Jaeger |

## 11. 盘点依据

以下是本索引的入口核对依据，不是本轮逐流程 Jaeger 通过证明：

- Gateway 外部入口：[会话与路由合同](../contracts/edge-gateway/session-contract.json)、[路由实现](../services/edge-gateway/internal/server/handler.go)。
- Console 业务入口：[BFF 合同](../contracts/admin-console/admin-contract.json)、[路由实现](../services/admin-console/internal/server/handler.go)。
- Identity 内部与协议入口：[Identity 合同](../contracts/identity/identity-contract.json)、[RPC 路由](../services/identity-service/internal/rpc/handler.go)、[SCIM 路由](../services/identity-service/internal/scim/http.go)。
- Agent 管控与后台入口：[Controller 接口](../services/agent-controller/internal/server/handler.go)、[Identity 撤销联动](../contracts/identity/principal-revocations.md)、[Controller 启动编排](../services/agent-controller/cmd/agent-controller/main.go)。
- ACP 入口：[v1 适配器](../services/agent-acp-service/src/transport/acp/v1/agent.ts)、[v2 适配器](../services/agent-acp-service/src/transport/acp/v2/agent.ts)、[会话配置](../services/agent-acp-service/docs/session-configuration.md)、[服务恢复](../services/agent-acp-service/docs/operations.md)。
- Runtime 与网络：[Runtime 职责](../runtimes/antnest-runtime/README.md)、[Runtime Controller 合同](../services/runtime-controller/api/control-api.md)、[Egress 职责](../services/runtime-egress/README.md)。
- 运维入口：[单节点运维](docker-single-node-operations.md)、[离线备份恢复](docker-backup-restore.md)。
