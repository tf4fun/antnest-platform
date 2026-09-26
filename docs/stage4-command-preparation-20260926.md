# 阶段四前置：跨渠道控制命令

日期：2026-09-26。范围：优化当前 Agent UI 服务，准备未来 Channel Gateway
消费的命令语义；不启动阶段四新服务，不修改已记录的阶段三验收结论。

## 已实现

共享合同见 [Workspace control commands](../contracts/agent-ui/workspace-commands.md)。
实现归 Agent UI 所有，ACP 与 Gateway 沿用已有接口和授权边界：

- Node 提供 11 个确定性命令：`/help`（别名 `/帮助`）、`/status`、`/usage`、
  `/new`、`/sessions`、`/resume`、`/fork`、`/model`、`/mode`、`/thinking`、`/stop`。
- Agent View 的 `controlCommands` 按当前 Session、配置能力及上游 fork 能力下发。
  原生 Agent `availableCommands` 继续作为 Session 元数据；同名控制命令优先。
- 控制命令通过受认证的 `POST /agents/{agentId}/commands` 分派，不创建 Prompt/Run、
  不调用模型。配置继续使用条件 token/CAS，停止继续使用原 operation/Run 目标。
- `/new` 选择本地草稿，首次普通消息才创建 Session。`/resume` 授权精确目标，
  `/fork` 使用 SDK 的 **UNSTABLE 实验性方法**，并受上游 `sessionCapabilities.fork`
  能力声明约束；不属于 ACP v1 稳定规范。失败结果不确定时要求核对目录而不自动重试。
- 新对话也能发现帮助、状态及会话导航。Agent 忙碌期间可编辑草稿及执行控制命令，
  普通 Prompt 的排他准入保持有效。带附件时禁止执行控制命令。
- 命令反馈只保留当前选择的最新一项，不进入模型历史；异步返回不能覆盖后来选择
  的工作环境/会话或清除后来编辑的草稿。

## 批次和证据

| 批次 | 状态 | 范围 |
| --- | --- | --- |
| B0 共享合同 | 已定义 | 控制目录、参数、权限、忙碌行为、文本反馈与选择结果 |
| B1 Agent UI Node | 本地门禁通过 | 242 项服务测试；16 项官方 ACP SDK/Node HTTP/SSE 集成；JSON schema 与实际配置目录 SSE delta |
| B1 后端部署验收 | 通过，临时资源已清理 | 生产 Node 容器；独立 Gateway/ACP/Runtime Docker 命令链路，全部 11 个命令 |
| B2 Agent UI 浏览器 | 自动化门禁通过，人工体验复核待定 | 补全目录、无 Session 控制、运行中输入、命令反馈；159 单元、134 组件及 HTTP/SSR 浏览器检查 |
| B3 前端部署集成 | 独立 Docker 浏览器回归通过 | 实际页面命令、双页 SSE 同步、配置控件、会话 URL/历史、刷新恢复和无额外模型调用 |
| Channel Gateway 消费 | 阶段四待交付 | 平台身份、绑定、外部消息去重与投递，不在本批 |

服务测试初次在沙箱内通过 225 项，8 项因本机端口 `listen EPERM` 失败；
原始失败日志保留。补充命令授权、能力限制、旧 Run 目标、失败不重试等边界后，
在允许本机端口的环境中完整重跑 242 项，全部通过。完整 HTTP/SSE 集成 16 项
全部通过，包含超时、断线恢复和慢客户端背压。新增控制命令的最初测试从缺失
实现的失败状态开始；实际运行态配置目录 SSE/JSON schema 检查也已通过。

预览镜像：`antnest/agent-ui:workspace-controls-20260926`，镜像 ID
`sha256:878571e7df853b367a60e4e518949db9ccae615fb067ad1d62031fe8f7538cb0`。
私有证据位于 `artifacts/verification/workspace-commands-20260926/`：
`server-tests.log`、`server-port-tests.log`、`control-runtime.log`、
`backend-integration.log`、`backend-controls-boundaries.log`、`backend-server-full.log`、
`backend-http-full.log`、`backend-container.log`、`backend-real-stack.log`、
`backend-docker-2026-09-26T02-57-28-703Z.json`、`backend-container-metrics.json`、
`backend-container-normal-stop.json`、`preview-image.log`、`preview-deploy.log`。

后端实际链路已确认：

| 行为 | 结果 |
| --- | --- |
| 无 Session 的帮助、状态、列表、恢复列表、新对话 | 不创建 Session，不调用模型 |
| 模型与 reasoning 配置 | 使用已发布能力，配置持久化；切回不支持的模型后隐藏并拒绝 thinking |
| Run 进行中的只读和导航命令 | 原 Run 继续，历史和 Session 数不变，无额外模型请求 |
| 同一配置 token 的两个并发写入 | 恰好一个成功，另一个 `409 configuration_conflict` |
| 停止命令 | 只取消指定 Run；错误及已结束的目标返回 409，不误停后续 Run |
| 空闲会话 fork 与 usage | 复制完成历史，只新增一个 Session；usage 返回实际报告值 |
| 登录、CSRF、跨用户、缺失 Session、撤销权限 | 分别拒绝，控制命令不能绕过已有权限边界 |

真实 Docker 用例只发送两次明确的普通 Prompt，模型端恰好接收两次请求；
其余全部控制命令未增加模型请求。生产容器回归同时保持了历史读取、SSE、
内存预算和正常退出的原有门禁。两套 Docker 回归串行执行，临时资源均已清理。

用户明确后端逻辑测试先行，因此上述后端 Docker 回归先独立执行。随后用户授权
阶段四前更新依赖并完整回归，包含此前等待的前端自动化检查。新依赖下的组件、
HTTP/SSR 浏览器检查及独立 Docker 页面联动均已通过；这不代替人工样式确认。

本轮证据位于 `artifacts/verification/dependency-refresh-20260926/`：
`additional-docker-03` 覆盖命令后端/页面和完整历史，`ui-controls-final-01` 进一步
确认刷新后的历史恢复并保存稳定截图。浏览器实际输入 `/model`、`/thinking`、
`/mode`、`/new`、`/resume`、`/fork`，检查配置持久化、双页同步、URL 和侧边栏；
导航命令不改变另一页面的会话选择，控制命令不增加模型调用。最初按钮定位错误
保留在 `additional-docker-02`，修正测试使用实际 `Run command` 按钮后通过。

后端回归入口（在 `services/agent-ui/web`）：`npm run test:server`、
`npm run test:bridge:integration`、`npm run test:bridge:docker`、
`npm run test:controls:docker`。最后一项默认通过独立 Docker 项目验证真实身份/CSRF、
配置并发 CAS、忙碌状态控制、旧停止目标、fork 历史和模型调用数量；设置
`ANTNEST_UI_CONTROL_BROWSER=1` 同时运行真实页面联动检查。

## 后续能力

2026-09-26 补充核查：本批后端证据基于锁定的 SDK 1.4.0；官方已于 2026-09-21
发布 [SDK 1.5.0](https://github.com/agentclientprotocol/typescript-sdk/releases/tag/v1.5.0)，
其中 `session/fork` 仍明确标记 UNSTABLE。[依赖更新批次](dependency-refresh-20260926.md)
已完成 1.5.0 的本地/数据库审计、SDK Docker、命令实际栈及完整历史矩阵回归；
已有 1.4.0 记录保留为历史证据。此前 2026-09-16 的 SDK 审计
是该日期的历史基线，不能再据其“最新”字样认定当前依赖已追平上游。

渠道审批入口、工作环境/Agent 绑定、技能命令、调度、`/queue`、`/steer` 待对应
能力批次交付。统一的是对外语义、发现与授权要求；会话执行归 ACP，渠道绑定及
外部投递归 Channel Gateway，不让未来渠道服务依赖浏览器页面或 UI 临时状态。
