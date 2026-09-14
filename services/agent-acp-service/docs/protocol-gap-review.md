# ACP 接口与 Goose 差异审查

> 执行边界更新（2026-09-15）：本文件记录此前协议补齐基线，不作为本轮重构验收结果。
> Controller 逐 Run admission/凭证/finish 已清退；ACP 按本地发布投影执行，最新责任与联调状态以
> [执行边界方案](../../../docs/controller-acp-execution-boundary-plan.md) 为准；Agent UI 暂缓。

> 日期：2026-09-08
> 基线：Antnest Platform `9cdd411`；Goose `5e90925`
> 范围：以稳定 ACP v1 为主线，单列草稿 v2；排除所有客户端 MCP 注入
> 状态：基线审查已记录；D 类修复见 §9；A1 传输适配与 A2–A4 决策见 §10；最新服务端完整性目标与旧 B 类重分类见 §5。§1–4、§6–8 描述审查时的基线，不代表修复后的当前行为或最新验收范围。

## 1. 结论与判定口径

**排除客户端 MCP 注入后，仍不能认定其他功能已经完整。**
会话生命周期、身份隔离、模型与 Runtime Tool 循环已有实际实现；主要缺口不是再增加一批方法，而是已有接口之间的内容转换、输出顺序、取消和运行中恢复语义没有完全闭环。

本轮发现七项实现问题。通过实际模块的小型本地探针验证了触发条件；没有调用外部模型、启动容器或修改数据库。涉及 SDK 的探针使用真实 SDK 与内存流，涉及执行的探针使用真实执行模块与可控依赖，不能替代真实 PostgreSQL/Runtime/Gateway E2E。

基线差异分类（其中 B 类的排除口径已被 §5 的最新决策取代）：

| 类型            | 定义                                                                | 处理方式                                       |
| --------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| A：架构不兼容项 | Goose/某类通用客户端的部署或资源假设与 Antnest 不同；不等于违反协议 | 明确接入前提，必要时做薄适配，不移动资源所有权 |
| B：取舍权衡项   | 协议可选、草稿扩展或 Goose 产品能力，当前未承诺                     | 产品决策，不自动升级为 MVP 缺陷                |
| D：缺陷项       | 已实现/宣称支持的路径存在错误，或违背当前产品的流程承诺             | 修复并增加针对性回归测试                       |

协议规则以 [ACP v1 初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[会话生命周期](https://agentclientprotocol.com/protocol/v1/session-setup)和相应接口页面为准。Goose 是实现参考，不是协议权威；其私有方法和局限不能直接转换为 Antnest 的合规要求。

源码入口：

- Antnest：[v1 adapter](../src/transport/acp/v1/agent.ts)、[v2 adapter](../src/transport/acp/v2/agent.ts)、[SessionService](../src/application/session-service.ts)、[RunExecutor](../src/application/run-executor.ts)、[TurnRunner](../src/application/turn-runner.ts)。
- Goose 位于外层参考仓库 `references/goose`：`crates/goose/src/acp/server/dispatch.rs` 是请求分发入口；`server.rs` 是会话/Prompt/输出实现；`server/load_session.rs` 是历史恢复；`transport/mod.rs` 是远程传输；`crates/goose-provider-types/src/formats/openai.rs` 是模型内容转换。
- Antnest 使用 TypeScript SDK `1.4.0` 的稳定入口和 `experimental/v2`；Goose 本轮检查的入口使用 Rust `schema::v1`。不能拿 Goose v1 证明 v2 完整。

## 2. ACP v1 逐接口对照

“基本实现”仅表示主路径存在且已有相关测试，不代表不存在下文边界问题。

| 接口/方向                                                           | ACP 要求或地位                                     | Antnest 当前行为                                                            | Goose 当前行为                                                      | 判定                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `initialize`，客户端到 Agent                                        | 基线；协商版本、能力                               | 固定返回受支持的 v1；拒绝重复初始化及初始化前的会话请求；按绑定宣告内容能力 | 初始化客户端能力与会话能力；参考实现直接返回请求版本                | 基本实现；内容能力的真实性见 D2/D4                           |
| `authenticate`                                                      | 按认证方式协商使用，不要求每个部署都采用交互式认证 | 连接前由 Gateway/Controller 完成绑定，不宣告认证方法                        | 宣告 `goose-provider`；当前分发器返回空认证响应，远程传输另有认证层 | A2；不应照抄一个空认证方法                                   |
| `logout`                                                            | 可选扩展                                           | 未宣告、未提供；平台退出在身份入口                                          | 本轮标准 dispatch 未发现处理器                                      | B；不能因此说缺少登录保护                                    |
| `session/new`                                                       | 基线                                               | 创建持久会话；绑定 principal/agent；仅 `/workspace`                         | 创建/激活 Goose Session，支持本地工作目录和配置                     | 基本实现；目录模型差异 A3                                    |
| `session/prompt`                                                    | 基线；完成前保留请求，最后返回 stop reason         | 授权、Run admission、上下文、模型、Tool 循环、持久结果；非流式模型请求      | 流式 Agent reply；输出转 ACP 通知后完成请求                         | 基本实现但未完整：D1/D2/D4/D6；无 token 流式为 B1            |
| `session/cancel`，通知                                              | 基线；停止当前工作并正确完成原 Prompt              | 持久取消标记与共享 RunSupervisor；取消运行中模型/工具                       | Session 共享取消 token、活动 Run 注册表                             | 常规路径已覆盖；结束边界 D6                                  |
| `session/update`，Agent 到客户端                                    | 基线输出通道                                       | 消息、思考、工具开始/结束、用量、会话元数据；历史可重放                     | 流式消息、思考、工具、用量，以及多种产品扩展通知                    | D1/D3/D5；可选呈现差异见 §3                                  |
| `session/load`                                                      | 宣告 `loadSession` 后提供；响应前回放完整历史      | 按持久 sequence 回放，逐条等待通知后响应                                    | 回放历史并恢复 Agent；还处理未完成的权限/状态机流程                 | 已结束会话路径基本实现；运行中重接 D3                        |
| `session/list`                                                      | 可选；宣告后遵守过滤、分页语义                     | 按 principal+agent 查询，50 条分页；排除已删除会话                          | 提供列表与筛选                                                      | 基本实现；非匹配绝对目录过滤 D7                              |
| `session/delete`                                                    | 可选；从列表移除，可软删除                         | 删除标记、保留历史；缺失/已删除幂等，外来会话仍拒绝；取消活动 Run           | Session 管理器删除并移除活动 Agent                                  | 基本实现；保留策略属于 B，不要求复制 Goose 物理删除          |
| `session/resume`                                                    | 可选；恢复但不回放历史                             | 激活会话、不回放消息；共享服务查询状态但 v1 不发送私有状态协议              | 本轮标准 dispatch 未发现 `ResumeSessionRequest`；主要通过 load 恢复 | Antnest 已提供，不能列成 Goose 有而我们缺少；运行中恢复见 D3 |
| `session/close`                                                     | 可选；停止活动工作，释放活动资源，可保留历史       | 关闭会话、持久取消、等待执行收敛；后续需 load/resume                        | 标记关闭、取消活动 Run、移除活动 Agent                              | 基本实现；取消结束边界仍受 D6 影响                           |
| `session/fork`                                                      | 草稿扩展；已经宣告则必须兑现                       | 仅空闲时复制上下文；新会话/消息 ID；不复制 Run                              | 提供 ForkSessionRequest 与会话配置通知                              | 基本实现；不能计入 v1 强制接口数量                           |
| `session/set_mode`                                                  | 可选模式能力                                       | 不提供会话级模式                                                            | 支持 Goose 模式切换并推送当前模式                                   | B2                                                           |
| `session/set_config_option`                                         | 可选配置能力                                       | 不提供；模型等由平台 Agent 配置确定                                         | 支持 provider/model/mode/thinking effort 等                         | B2；没有该接口不等于无法更新平台配置                         |
| `providers/list`                                                    | Provider 管理草稿扩展                              | 不提供；属于平台控制面                                                      | 有 `_goose/*` Provider inventory 管理，不据此宣称标准方法已实现     | B2/A2                                                        |
| `providers/set`                                                     | 同上                                               | 不提供                                                                      | 同上，配置选择也可走 session config                                 | B2/A2                                                        |
| `providers/disable`                                                 | 同上                                               | 不提供                                                                      | 同上                                                                | B2/A2                                                        |
| `session/request_permission`，Agent 到客户端                        | Agent 可选择请求用户许可                           | 无请求/审批挂起流程；工具按平台授予的执行边界使用                           | Tool confirmation 转成客户端许可请求，反馈给 Agent 状态机           | B3；没有交互审批，不是权限隔离失效                           |
| `elicitation/create`，Agent 到客户端                                | 可选结构化追问                                     | 未实现                                                                      | 存在 form elicitation 处理，按客户端能力分流                        | B3                                                           |
| `elicitation/complete`，Agent 到客户端                              | 可选交互的完成通知                                 | 未实现                                                                      | 本轮仅确认 form 工作流，未逐形态验收完成通知                        | B3；不把 SDK 类型存在当成 Goose 完整支持                     |
| `fs/read_text_file`，Agent 到客户端                                 | 客户端文件系统能力，非所有 Agent 必须使用          | 不调用；读取发生在 Runtime                                                  | 可按客户端能力使用客户端文件系统扩展                                | A3                                                           |
| `fs/write_text_file`，Agent 到客户端                                | 同上                                               | 不调用；写入发生在 Runtime                                                  | 同上                                                                | A3                                                           |
| `terminal/create`，Agent 到客户端                                   | 可选客户端终端能力                                 | 不调用；Bash 在 Runtime 执行                                                | 按客户端能力启用终端扩展                                            | A3                                                           |
| `terminal/output`、`terminal/wait_for_exit`                         | 同一客户端终端的输出/等待                          | 不调用                                                                      | 属于客户端终端扩展                                                  | A3；不能误写成 Antnest 没有执行和等待能力                    |
| `terminal/kill`、`terminal/release`                                 | 同一客户端终端的终止/释放                          | 不调用                                                                      | 属于客户端终端扩展                                                  | A3                                                           |
| `nes/start`、`nes/suggest`、`nes/accept`、`nes/reject`、`nes/close` | 编辑器补全草稿能力                                 | 未宣告、未实现                                                              | 本轮标准 dispatch 未发现相应处理器                                  | B4；不是聊天 Agent 基线                                      |
| `document/didOpen`、`didChange`、`didClose`、`didSave`、`didFocus`  | 配套编辑器通知                                     | 未启用                                                                      | 本轮标准 dispatch 未发现相应处理器                                  | B4                                                           |
| `$/cancel_request`                                                  | 通用请求取消机制，不等价于语义取消 Run             | SDK 处理协议层；没有承诺中断每种业务操作                                    | SACP SDK 处理机制，不据此宣称业务中断完整                           | 不新增 Run 语义；主要验收 `session/cancel`                   |

接口语义依据：[Session setup](https://agentclientprotocol.com/protocol/v1/session-setup)、[Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[Session list](https://agentclientprotocol.com/protocol/v1/session-list)、[Session delete](https://agentclientprotocol.com/protocol/v1/session-delete)、[Session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)、[Request cancellation](https://agentclientprotocol.com/protocol/v1/cancellation)。

## 3. 不能只看方法名的内容与通知子能力

| 内容/通知                            | Antnest                                                       | Goose                                                                           | 分类                                         |
| ------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| 文本 Prompt                          | 原样进入模型上下文并持久化                                    | 支持，保留 audience 等注解                                                      | 基本实现                                     |
| `resource_link`                      | 将名称、URI、描述提供给模型；不自动读取客户端文件             | 对可读取的 `file://` 引用尝试宿主机读取                                         | A3；ACP 接受引用不等于必须服务端自动下载     |
| 内嵌文本 resource                    | 文本和 URI 进入上下文                                         | 转成带 URI 的文本                                                               | 基本实现                                     |
| 内嵌 blob resource                   | Base64 原样拼入文本                                           | ACP Prompt 转换只处理 TextResourceContents，二进制被忽略                        | D4；Goose 也不能作为二进制完整性的正面证明   |
| 用户图片                             | 模型允许图片时转 `image_url`；否则提前拒绝                    | 提供图像内容通道，模型适配器考虑 vision 支持                                    | 主路径已有；不等于 Tool 图片也正常           |
| 用户音频                             | 不宣告、不接收                                                | 参考入口同样未宣告 audio                                                        | B5                                           |
| Tool 图片结果                        | 可进入持久事件/ACP 输出，但下一次模型转换失败                 | OpenAI adapter 把图片作为额外 user image 内容；非视觉模型明确省略               | D2                                           |
| Tool 状态与参数                      | 开始、完成、失败；提供 rawInput 与内容；v1 取消映射为失败状态 | 有较丰富的标题、种类、diff、location 与结果映射                                 | 基础已有；ID 唯一性 D5；富呈现 B6            |
| `agent_message_chunk` / thought      | 按完整模型结果发块，不是 token 流                             | 随 Agent reply stream 推进                                                      | B1；“使用 chunk 类型”不证明模型正在流式输出  |
| plan / commands / 模式 / config 通知 | 不提供结构化计划、命令菜单、模式与会话配置通知                | config/mode 与私有产品通知较丰富；未将所有标准 plan/commands 形态逐项验收为完整 | B2/B4/B6                                     |
| `usage_update`                       | 提供 used/size，无成本金额                                    | 标准用量加私有用量信息，可提供成本                                              | B6；不能把可选成本缺失算协议缺陷             |
| Runtime 配置更新                     | 每个 Run 从 `acquire_run` 获取最新不可变快照                  | Goose 通常管理本地 Session Agent 及其配置                                       | A4；不需要凭空增加 ACP `update_runtime` 方法 |

内容与 Tool 呈现的规范依据：[Content](https://agentclientprotocol.com/protocol/v1/content)、[Tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls)。可选呈现不要求复制 Goose 的全部产品 UI。

## 4. 架构不兼容项

### A1. 传输与启动方式

Antnest 是多用户远程服务，只提供 `/v1/acp`、`/v2/acp` WebSocket。Goose 可通过 stdio 启动，也在 `serve` 中使用官方 HTTP server 提供 `/acp`。仅会启动本地 ACP 子进程或仅支持 Streamable HTTP 的客户端不能直接连接当前 Antnest。

这是接入方式差异，不是客户端 MCP stdio 问题。[ACP v1 允许自定义双向传输](https://agentclientprotocol.com/protocol/v1/transports)。需要通用客户端互通时可以增加薄传输适配，不应把 Agent compute 移入 Runtime。当前不存在 POST/GET/DELETE Streamable HTTP 接口，不能宣称已经兼容它。

### A2. 身份与 Provider 的权威来源

Antnest 在连接建立前解析 Agent-scoped subject，每次业务操作校验绑定；用户登录、配置凭证与 Provider catalog 不由会话客户端任意控制。Goose 的本地配置、Provider 登录和 Session 配置更偏向单使用者 Agent。

不支持 ACP 内交互登录/Provider 管理，不等于没有身份体系。不建议为表面一致新增空成功方法或第二套凭证权威。

### A3. 工作目录与客户端资源

Antnest 的 `/workspace` 属于远程 Runtime；Goose 的 cwd、客户端文件/终端可能指向编辑器所在机器。不可直接把客户端绝对路径解释为 ACP 主服务的宿主机路径。

不提供客户端 fs/terminal、多工作目录是已明确的环境边界；但 `session/list` 的查询过滤不创建或访问环境，不应该复用创建环境的限制，见 D7。

### A4. 配置/重建不属于会话协议

Agent Controller 是 Agent 配置权威，Runtime Controller 部署执行环境，ACP Service 在 admission 时读取当前版本。无需新增非标准 ACP 字段或 `update_runtime` 才能使用重建后的 Runtime。每个 Run 固定快照与平台锁定语义应继续在内部合同验收。

## 5. 服务端完整性目标与补齐清单

逐项核查后的当前清单见 [ACP v1 功能补齐与 Goose 复用方案](protocol-completion-plan.md)：F01–F10 是实现缺口；原 W1–W5 已按“非架构行为优先复用 Goose”收敛。用户进一步确定：组织内可用模型允许会话切换；Agent 提供默认授权行为，Session 可单独覆盖。W 类已无待决策项，但不代表实现完成。已确认架构边界和等待稳定项另列。本节保留旧 B 类的映射，不替代新清单的状态结论。

### 5.1 最新决策（2026-09-08）

**除明确的架构不兼容项和等待协议稳定的项目外，服务端应尽可能实现全部 ACP 能力。客户端再按实际场景选用，不能由当前 Console、Agent UI 或渠道界面的需求反向裁剪服务端协议。**

1. 协议的可选能力仍是服务端的实现目标。`MAY`、当前客户端不用、没有 UI 入口、Goose 没做、SDK 有类型但本服务没 handler，都不是排除理由。
2. 区分协议最低合规、服务端功能完整、客户端呈现范围。未实现时不宣告能力、明确拒绝请求是必要保护，但负向测试通过不等于该功能完成，也不能清除待办。
3. 每项排除必须记录具体接口/子能力、架构冲突或提案状态、依据和重审条件。状态尚未核实应标为待核对，不能自动视为等待稳定。稳定 v1 为主线；已实现的草稿能力继续维护，不能借稳定性分类撤掉既有功能。
4. A2–A4 的身份、配置、工作区和部署权威保持不变。协议处理器可以在权限范围内调用对应业务服务；平台掌握配置权威不等于禁止会话级授权选项。客户端 MCP 仍按现有信任边界与 MCP-over-ACP 稳定性决策处理。
5. 服务端具备能力不等于所有调用都强制启用。仍需遵守客户端能力协商、身份授权、模型实际支持和策略；不得伪造内容、费用、审批成功或命令执行结果来凑接口覆盖率。
6. Goose 用于验证可落地的流程，其私有 `_goose/*` 不属于 ACP 标准清单。需要相同业务能力时先确认标准表达，不能新增私有方法后宣称标准协议已经完整。
7. 非架构行为优先沿用 Goose 的成熟实现，不重复设计模式、许可交互、内容转换和费用算法。只对多用户隔离、Controller 权威、远程 Runtime 与持久 Run 做必要适配；Goose 自身的稳定协议缺口不成为豁免。
8. 组织内可用模型均进入授权选择范围，不新增 Agent 专属模型清单。Agent 默认配置与 Session 覆盖分离：Controller 管理组织模型/凭证与 Agent 默认授权，ACP 管理会话选择和授权覆盖；会话操作不隐式回写 Agent 默认，不影响其他会话或已接受的 Run。

实施进度（2026-09-10）：F01–F06 已实现，F02–F06 已有部署验收，F05/F06 已接入 Agent UI；F07 等待官方 MCP SDK，不维护补丁。F08 命令目录、标准 Prompt 执行及恢复已实现，v1 HTTP、v1/v2 WS 与 Gateway/Runtime/Jaeger 部署验收通过。F09 的 ACP 原生音频/PDF、Controller 模型权威与能力声明、Console/BFF 配置、Agent UI 输入与回放已完成服务批次，三种协议入口及 Jaeger 部署联调通过；不把模型夹具视为真实识别质量证明。F10 ACP 费用消费、Controller 价格管理、Console/BFF 编辑及 Agent UI 消费已通过服务批次验收，共享合同与快照已对齐，三种入口、重启恢复、身份隔离及 Jaeger 部署联调通过。单节点最终浏览器与运维验收仍独立推进。前文接口表保留初次审查基线，不代表当前缺口；最新状态以 [补齐计划](protocol-completion-plan.md) 与 [协议验收](protocol-conformance.md) 为准。

### 5.2 旧 B 类重分类

下表是已发现差异的重新归类，不是完整协议枚举。后续逐接口清单还必须覆盖所有请求、通知、内容类型、能力协商及其组合，不局限于 B1–B8。

| 原 ID | 拆分后的能力                                                     | 当前状态与推进要求                                                                                                                                                       |
| ----- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1    | 模型文本/思考增量输出                                            | **实现缺口，优先补齐**。由模型事件持续驱动标准 `session/update`；不能把完整响应拆字当流式，也不能只验证 SSE 可连通。                                                     |
| B1    | 工具进度和连续结果输出                                           | **实现缺口，优先补齐**。打通有进度来源的 Runtime/MCP 调用、执行事件与 Tool 更新；不为无进度的工具伪造百分比。                                                            |
| B2    | 会话配置发现、授权选择、配置变化通知                             | **纳入补齐清单**。逐项核对稳定方法，保留 Controller 配置权威；不能整组以 Provider 权限为由排除。                                                                         |
| B3    | 用户许可请求与交互结果回传                                       | **纳入补齐清单**。覆盖允许、拒绝、取消、断线恢复及跨身份隔离；是否需要用户批准由策略决定，不以当前无审批 UI 为排除理由。                                                 |
| B3    | 结构化 elicitation                                               | **已确认稳定，纳入 F07**。form、URL 和 complete 保留为目标；2026-09-09 用户决定等待官方 MCP SDK 支持后恢复实施，不维护补丁。见 [实施计划](protocol-completion-plan.md)。 |
| B4    | 标准命令发现与调用、NES/document                                 | **已拆分**。命令发现/执行纳入 F08；NES/document 官方 RFD 仍为草稿，等待稳定。                                                                                            |
| B4/B7 | Goose 私有 recipes/scheduler/steer                               | 不是 ACP 标准接口。标准化对应能力另行核对；已有 scheduler 规划不因本轮协议补齐而自动启动。                                                                               |
| B5    | 音频及其他标准内容形态                                           | **纳入补齐清单**。服务端提供有实际模型/转换支持的处理链，按真实能力协商；不支持的组合明确拒绝，不能静默丢弃或只通过 schema 校验。                                        |
| B6    | Tool kind/title/location/diff/rawOutput、结构化 plan、usage/cost | **拆分纳入补齐清单**。按标准及真实执行信息映射；缺少进度、价格或 diff 来源时不得伪造。Goose 未实现某个映射不构成豁免。                                                   |
| B7    | 执行中追加输入与反馈                                             | **按版本核对标准方案**。不把 Goose 私有 steer 或 v2 草稿行为冒充 v1 标准；稳定方案存在则纳入实现，否则明确记录等待项。                                                   |
| B8    | 软删除保留审计、未知副作用不自动重放                             | **保留已有语义**。这是实现方式而非未实现的协议能力；仍须满足取消、历史恢复、生命周期及错误反馈合同，不能用它为消息遗漏开脱。                                             |

### 5.3 交付与验收

1. 逐接口列出标准版本/稳定性、输入输出与通知、当前实现、缺失链路、排除依据和测试。尚未实现或缺少正向证据的条目不得标记完成。
2. 按服务所有权分批执行 `doc -> test -> code`，最后联调。模型输出批次先在 Agent ACP Service 闭环；工具进度涉及 Runtime 时另立生产者批次，再对接消费者，不一次修改所有服务。
3. 补齐真实 wire 正向测试、能力协商/权限负向测试，以及适用的持久化、取消、断线恢复、历史重放、错误和背压测试。输出必须到达客户端，交互结果必须影响实际执行，不能只断言通知被构造。
4. 明确模型增量与工具进度早于调用完成到达客户端；最终结果不重复，完成响应不越过先前通知。已有 D1–D7 的顺序、恢复、内容和身份保证必须回归。
5. 以非浏览器协议客户端证明服务端能力，再由 UI/渠道挑选呈现方式；单纯缺少 UI 不阻塞服务端交付。涉及 Gateway/Runtime 的业务在对应批次后串行完成集成验收。

当前 Model adapter 只有 OpenAI-compatible，不等于 ACP 方法只需覆盖该 Provider 的最小用法；内容支持需要对应模型或转换链的真实证据。上下文压缩等内部策略也不因没有名为 `session/compact` 的稳定接口就算缺失，应另按 Agent Core 语义验收。

## 6. 缺陷项与修复证据要求

### D1 / P1. v1 完成响应可能早于剩余回复内容

- 位置：[DurableRunEvents.publish](../src/application/durable-run-events.ts)、[v1 publisher](../src/transport/acp/v1/agent.ts)。持久事件发布不等待完成；一个事件的多个内容块却逐块等待发送，终态响应可以插到中间。
- 本地真实 SDK + 延迟输出流的结果：`block1 -> end_turn -> block2`。这不是单纯缺少流式功能，而是同一 Prompt 的完成边界错误。取消场景的更新必须先于原 Prompt 响应，协议对此有明确约束。
- Goose 的 `on_prompt -> forward_agent_stream` 在转发循环返回后才构造响应，没有 Antnest 这里的 detached publisher 加多块异步等待组合；本轮没有对 Goose 做背压测试。
- 修复方向：会话输出使用有序交付队列；执行持久化不被断线拖住，但在线连接的终态必须排在此前通知之后。区分“已入队”“已交付”“已断开”，不能用吞掉全部错误代替顺序定义。
- 必补：真实 wire 多块回复 + 慢发送、取消时剩余输出、断线时执行仍能结束；断言终态之后没有属于原 Prompt 的迟到内容。

### D2 / P1. Runtime Tool 返回图片会破坏模型循环，错误原因还被覆盖

- 位置：[TurnRunner.callTool](../src/application/turn-runner.ts)、[OpenAICompatibleModel](../src/adapters/model/openai-compatible.ts)。工具结果作为 `role=tool` 回传；`textContent` 不接受 image，即使模型支持图片也失败。
- 本地探针：视觉模型配置下，Tool 图片触发 `model_unavailable`、`retryable=true`，内部原因是 `model_unsupported_content`，**实际 fetch 一次都没有发生**。工具图片进入保留上下文后，还可能影响下一次 Prompt 的模型请求。
- Goose 的 `formats/openai.rs` 为 Tool 图片构造后续 user image 消息；非视觉模型则保留明确的省略说明，不把格式错误当外部网络错误。
- 修复方向：在模型适配层完成 Tool 多模态规范化；区分不支持的内容、模型响应错误和网络不可用。无需增加外部图片工具或客户端 MCP。
- 必补：管理员提供的 Runtime MCP 返回文本+图片 -> 第二次真实 adapter 请求 -> 最终回复；非视觉降级、保存后再次 Prompt；断言本地格式错误不会成为 retryable 网络错误。

### D3 / P1. 运行中重新连接只恢复快照，没有接续后续输出

- 位置：[SessionService.resumeSession](../src/application/session-service.ts)、[RunSupervisor.execute](../src/application/run-supervisor.ts)、[v1](../src/transport/acp/v1/agent.ts) / [v2](../src/transport/acp/v2/agent.ts) publisher。输出目标固定为发起 Run 的连接，resume/load 不注册新的订阅者。
- 本地真实 v2 SDK 两连接探针：旧连接发起 Prompt 后关闭，新连接 resume 收到 `running`；执行完成为 `idle`，新连接仍只有那一条 `running`，没有新回复和 `idle`。共享应用依赖受控，验证的是实际协议 adapter 的交付路径，不是 PostgreSQL 恢复 E2E。
- v1 的 load 也只有查询当时的历史；之后新产生的内容依然发往旧连接。只能再次 load 补取，不能称为恢复后持续使用闭环。
- Goose 在承载 Prompt 的 future 被丢弃时通过 `ActiveRunDropGuard` 取消/清理 Run。它选择了另一种连接语义，不能据此要求 Antnest 也取消后台工作；但 Antnest 保留工作时必须定义接续交付。
- 这是远程产品恢复承诺缺陷；**不将通用 v1 多连接广播说成协议强制要求**。
- 必补：先订阅再以 sequence 补历史、消除回放/实时交接空隙；真实持久化下断线 -> 活动 Run 中 load/resume -> 后续输出/终态到新连接，测试重复与遗漏。无需引入外部消息总线。

### D4 / P2. Embedded context 的二进制附件只有形式支持

- 位置：[embeddedResourceText](../src/adapters/model/openai-compatible.ts)。blob 变为 `MIME + Base64` 普通文本，没有按类型解码、提取或转成模型支持的文档内容。
- 本地 `text/plain` Base64 附件探针只得到 Base64 字符串，而不是解码后的文本。Agent UI 对非文本附件也发送 resource blob；尤其 PDF 接收成功不能证明模型可理解文档。
- Goose 的 ACP Prompt 转换也没有实现二进制 resource 完整处理；不要照抄其忽略 blob 的行为。ACP 定义了资源形式，但不保证任意模型能够理解所有二进制 MIME。
- 修复方向：明确支持的 MIME；文本可解码，支持的二进制走提取/模型文档能力或 Runtime 文件交接；不支持的附件在 admission 前明确拒绝，而不是接受后伪装文本成功。
- 必补：文本 blob、中文编码、PDF/图片资源、未知二进制分别断言实际模型输入或明确拒绝；不能仅断言 JSON 未丢字段。

### D5 / P2. Tool ID 仅依赖 Provider ID，未保证 Session 内唯一

- 位置：[ToolPreflight](../src/application/tool-preflight.ts) 只校验同一批调用；[run-event-repository](../src/adapters/postgres/run-event-repository.ts) 直接使用模型 ID；数据库只约束 `(run_id, tool_call_id)`。
- 本地两个 Run 的模型都返回 `call_1`，两个 Run 均成功且发出相同 Tool ID。ACP adapter 原样转发，Agent UI 也以 `toolCallId` 作为会话内工具条目标识，会覆盖旧条目。
- ACP Tool 标识要求 Session 内唯一。Goose conversion 同样使用请求 ID；本轮没有证据证明它的每种 Provider 都能保证全 Session 唯一，因此不宣称 Goose 已解决这个问题。
- 修复方向：区分模型侧调用 ID 与协议/持久化侧稳定标识，以 Run/attempt 身份生成 Session 唯一的 ACP ID；开始、更新、重放、fork 保持对应一致。
- 必补：同 Session 两个 Prompt 重用模型 ID，工具历史不覆盖；同 Run 不同模型轮次重用 ID 的明确策略；load/fork 后再次调用仍不冲突。

### D6 / P2. 结束边界的取消可能被报告为正常完成

- 位置：[TurnRunner.run](../src/application/turn-runner.ts)：模型返回之后只检查 worker authority，不再检查用户取消；等待 usage/thought/最终消息持久化后直接返回 completed。
- 本地在 usage 写入阶段触发取消，实际返回 `completed/end_turn`；此时 Run 尚未完成，也没有未知副作用需要保守处理。
- Goose 的 `forward_agent_stream` 在循环结束时再次检查取消 token，再选择 Cancelled。该做法可作为明确终态归属的参考。
- 修复方向：定义取消与完成的最终判定点；取消已生效但终态未确定时，不应因刚好收到模型结果就无条件成功。不改写已持久化的真正完成结果。
- 必补：模型完成后、usage/thought 持久化期间、最终消息持久化期间分别取消；原 Prompt stop reason、数据库终态和 admission finish 一致。

### D7 / P2. `session/list` 把目录过滤误当成新建工作目录

- 位置：[SessionService.listSessions](../src/application/session-service.ts) 调用只接受 `/workspace` 的 `requireWorkspace`。
- 本地 `cwd=/other-project` 返回 `unsupported_workspace`；根据 list 接口，它是合法绝对目录且无匹配结果，应返回 `sessions: []`。
- 新建会话只支持平台工作区是 A3；查询其他目录没有创建环境或越界读文件，不应受同样限制。Goose 提供目录筛选，但本轮未对其做所有过滤边界实测。
- 修复方向：分离“目录查询参数合法性”和“环境创建权限”。
- 必补：存在匹配、无匹配绝对路径、相对路径、分页结合 cwd、跨 principal/agent 过滤。

以上 D1/D5/D6/D7 的协议依据分别见 [Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[Tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls)和 [Session list](https://agentclientprotocol.com/protocol/v1/session-list)。D2/D3/D4 同时涉及产品功能承诺，不简单等同于 SDK schema 不合法。

## 7. 草稿 v2 单列核对

| 接口/变化                                                             | 当前实现                                                     | 审查结论                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `initialize`                                                          | 官方 experimental/v2 SDK；协商 v2 能力                       | 基本实现，不与 v1 混用字段                        |
| `session/new`、`session/list`                                         | 共享会话应用服务                                             | 基本实现；list 同受 D7 影响                       |
| `session/resume`                                                      | 不要求历史时仅恢复；`replayFrom=start` 回放并报告状态        | 存量历史路径有实现；运行中重接 D3                 |
| `session/close`                                                       | 共享关闭/取消流程                                            | 基本实现；结束边界 D6                             |
| `session/delete`、`session/fork`                                      | 显式宣告并实现                                               | 基本实现，不能只因在 SDK 内就称为 v2 全部强制能力 |
| `session/prompt`                                                      | 先 ACK，再 user message/running，再后台执行及 idle           | 版本语义分离正确；模型/内容层仍受 D2/D4/D6 影响   |
| `session/cancel`                                                      | 通知进入共享授权和取消流程                                   | 常规路径已有；D6 仍需修复                         |
| `session/update`                                                      | 全消息 upsert 带 messageId；tool update、usage、running/idle | 与 v1 chunk 映射明确区分；D3/D5 仍存在            |
| `auth/login`、`auth/logout`                                           | 未宣告                                                       | A2，而不是把 v1 authenticate 错挂到 v2            |
| `session/set_config_option`、`providers/*`、elicitation、NES/document | 未提供                                                       | 与 v1 对应的 A/B 决策一致                         |
| v1 `session/load`、`session/set_mode`、客户端 fs/terminal             | 不挂在 v2 adapter 下                                         | 是版本差异，不是缺陷                              |
| JSON-RPC batch、`$/cancel_request`                                    | 官方 WireStream 与已有 wire 测试                             | 传输级覆盖，不自动证明业务生命周期完整            |

v2 对 ACK、消息 ID、running/idle 的要求见 [Prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)；恢复行为见 [Session setup](https://agentclientprotocol.com/protocol/v2/session-setup)。本轮没有使用 Goose v1 为这些 v2 结论背书。

## 8. 验证边界与推进建议

之前提交记录的 215 个单元/组件用例和 53 个 PostgreSQL 用例通过是有效的历史结果；它们不覆盖本轮所有触发条件。本轮没有重复全量套件或伪造新的平台验收结果。

本轮七项本地探针结果：

| 探针                    | 结果                                                   | 证据级别                                 |
| ----------------------- | ------------------------------------------------------ | ---------------------------------------- |
| 多块通知 + 慢输出流     | `block1 -> end_turn -> block2`                         | 实际 v1 SDK + DurableRunEvents，受控存储 |
| Tool 图片模型输入       | fetch 未调用；错误被包装为 retryable model_unavailable | 实际 Model adapter，合成请求             |
| 活动执行中关闭/恢复连接 | 新连接仅收到 running，结束内容/idle 未收到             | 实际 v2 SDK，受控应用执行与恢复          |
| 内嵌文本 blob           | 模型输入仍为 Base64 普通文本                           | 实际 Model adapter，合成附件             |
| 跨 Run 重复模型 Tool ID | 两次成功均产生 call_1                                  | 实际 TurnRunner，受控模型/工具/事件      |
| usage 持久化阶段取消    | 返回 completed/end_turn                                | 实际 TurnRunner，受控事件存储            |
| 无匹配绝对 cwd 查询     | unsupported_workspace                                  | 实际 SessionService，受控仓库            |

建议仍按服务内的小批次推进，不以“补齐 Goose 所有功能”为目标：

1. **输出生命周期**：D1+D3+D6；统一输出顺序、连接恢复和终态判定，补真实 wire + PostgreSQL 集成测试。
2. **内容进入模型的语义**：D2+D4；输入和 Tool 结果共用清晰的内容规范化策略，补模型请求体与持久上下文回归。
3. **会话标识与查询语义**：D5+D7；补跨 Run/回放/fork 标识与过滤测试。
4. 三批通过后，再做 Gateway -> v1 -> Runtime MCP -> 模型 -> 客户端的全平台验收；Goose 联调只验共同接口，不调用其私有扩展或本轮排除的客户端 MCP。

当前最应修复的是已有能力的闭环，而不是增加 permissions、modes、NES 或更多协议方法来提高接口数量。

## 9. 缺陷修复执行清单

用户已批准先修复 D 类缺陷，再讨论 A/B 类差异。本次只修改 Agent ACP Service；不开放客户端 MCP、不增加新的跨服务依赖，不调整身份或 Runtime 的权威归属。

1. [x] D1/D3/D6：有序输出与可续接会话，明确取消/完成判定点；已补慢连接、多块回复、活动 Run 断线恢复和取消边界测试，并通过服务级 PostgreSQL 验证。
2. [x] D2/D4：模型内容规范化；Tool 图片按视觉能力处理，完整 Tool 批次结束后附图片；文本 blob 解码，不能理解的二进制在接纳前拒绝；保留明确的本地错误分类。定向测试已通过。
3. [x] D5/D7：会话级 Tool 标识与查询过滤；已补跨模型请求/Run、历史回放、fork 和合法无匹配目录测试，并通过服务级 PostgreSQL 验证。
4. [x] 串行运行服务全套单元/组件测试、PostgreSQL 集成、生产构建、仓库格式与 lint 门禁；最终结果见下表，不保存过程日志。
5. [x] 已按 D1–D7 逐项复核实现与测试覆盖；A/B 项留待下一轮讨论，未执行的全平台 E2E 不标记为通过。

实现收口说明：

- 输出仍以现有持久消息为权威，仅新增连接级游标和失效通知，不增加消息表、轮询循环或跨服务消息总线。v1 等待有序通知交付后返回；v2 idle 必须晚于持久终态和 admission 关闭。连接失败不阻塞 Run 收敛。
- 新连接在授权后恢复游标并持续接收输出；读取时再次校验身份，权限失效则断开输出连接，不继续向旧身份交付消息。此行为不替代身份服务的停用业务链路。
- Tool ID 在进入循环时基于 Run、模型请求序号和原始 ID 统一生成；事件与模型上下文引用同一 ID，不增加协议私有字段或第二份映射表。
- 文本 blob 支持解码不等于支持 PDF：未实现解析的二进制在接纳前明确拒绝，避免创建一个必然失败或误读附件的 Run。Tool 图片在视觉模型的完整 Tool 批次之后发送；无视觉能力则明确省略。
- 本批只处理 D 类缺陷。A/B 项保留供下一轮决策，不顺带增加协议传输、权限交互、模型切换或客户端 MCP 功能。

### 最终服务级验证

| 验证                                           | 结果                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| 全套单元/组件 `npm test`                       | 33 文件，245 项通过                                                               |
| 完整 PostgreSQL `make test-agent-acp-postgres` | 8 文件，61 项通过；包含真实 ACP wire、权限隔离、历史恢复与本批新增场景            |
| 生产构建 `npm run build`                       | 通过                                                                              |
| 仓库格式 `make fmt-check`                      | 通过                                                                              |
| 仓库完整 `make lint`                           | 通过；Go lint 0 issues、两项 Rust Clippy、ACP ESLint/TypeScript、两个前端类型检查 |
| 本批 Gateway/Runtime/外部模型全平台 E2E        | 未重跑，不作为本批新增证据                                                        |

所有重型验证串行执行。使用本轮新建的单个 PostgreSQL 实例和服务专用测试数据库；测试后已移除本轮容器、数据卷及五个数据库网络，未保留测试进程。没有调用外部模型，也没有更改其他服务的实现或数据库结构。

## 10. A 类决策与 HTTP 适配

用户确认 A2–A4 属于平台既定设计，不作为待修复项：身份/Provider 权威
在控制面，工作区在远程 Runtime，配置/重建通过 Controller 内部 RPC。
B 类取舍和所有客户端 MCP 注入不在本批范围内。

A1 参考 Goose `serve`，不迁移 Agent compute，不建立第二套应用 API：

1. ACP Service 使用已安装的官方 TypeScript SDK `1.4.0`
   `experimental/server` 与 `experimental/node` 提供 `/v1/acp`
   POST/GET/DELETE；复用既有 v1 Handler 和应用层。v1/v2 WebSocket 保留。
2. HTTP 连接绑定 subject/principal/agent/access revision；每次请求重新解析
   访问权限，连接 ID 不作为凭证。SDK 负责传输队列，持久 Session 仍由应用层负责。
   连接数和空闲保留时间有边界，DELETE/断线不变成业务会话删除或 Run 取消。
3. Gateway 在 v1 路径和既有 alias 增加透明转发，保留 cookie/CSRF 策略。
   SSE 即时 flush，与 POST/DELETE 使用独立准入配额；不向内部转发客户端凭证。
4. `/v2/acp` 本批仍只有 WebSocket；未实现 v2 HTTP/batch 传输或本地 stdio
   启动桥。官方 HTTP SDK 本身为实验性入口，不宣称 HTTP 已成为稳定 v1 强制要求。

合同及运维边界见 [HTTP transport](http-transport.md) 和
[Gateway README](../../edge-gateway/README.md)。

### 本批验证

| 验证           | 结果                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP 单元/组件  | 34 文件、255 项通过；包含 10 项 HTTP 接入、身份与资源生命周期测试                                                                                   |
| ACP PostgreSQL | 9 文件、66 项通过；新增 HTTP Tool/回复顺序、取消、活动 Run 重连、跨身份隔离、HTTP/WebSocket 历史互通                                                |
| Gateway        | 全模块测试及 `-race` 通过；标准 golangci-lint 0 issues                                                                                              |
| 生产构建       | ACP TypeScript 构建、ACP Service 与 Gateway Docker 镜像构建通过                                                                                     |
| 仓库准入       | `make fmt-check`、`make lint` 通过；Go 标准 lint、两项 Rust Clippy、ACP ESLint/类型检查、两个前端类型检查均通过                                     |
| Docker Stage 3 | `scripts/e2e-stage3a.sh` 通过；Workspace 客户端分别执行 WebSocket 和 HTTP 的真实 Runtime Tool/聊天/断线后回放，原有身份、生命周期和 Jaeger 验收通过 |

单服务 PostgreSQL 验证复用已有开发实例，仅创建并删除独立测试数据库。
Docker 联调使用自动清理的临时项目 `antnest-stage3-e2e-14950`，容器、卷、网络
已清理并复查；原有开发实例不变。模型为合成测试服务，未调用外部 Provider。
本批没有浏览器 UI 修改；也没有将原有 Jaeger 检查扩大解释为每一个新增 HTTP
Prompt 均完成独立的逐 span 父子关系验收。
