# 服务级可观测性改造与统一验收

> 日期：2026-09-11。依据 [埋点规范](observability-contract.md)。
> 后续数据库自动埋点与事务层级改造见 [数据库实施报告](observability-database-remediation.md)，不再以 Repository 方法名作为存储执行证据。
> 本轮用户明确授权按服务并行修改，协调者统一验收；不扩大为跨服务业务重构。

## 范围与所有权

| 服务 | 本轮负责内容 | 当前状态 |
| --- | --- | --- |
| Edge Gateway | 公共 HTTP 入口、Transport、代理、错误与安全诊断 | 上轮已验收，本轮保留并做集成回归 |
| Admin Console | BFF 入站与转换后出站、错误返回、本地 readiness | 代码门禁与镜像构建通过 |
| Identity Service | 身份 RPC、OIDC/SCIM、存储边界与安全诊断 | 代码门禁、PostgreSQL 与镜像构建通过 |
| Agent Controller | 配置/模板/Agent API、生命周期 runner、依赖调用与 Links | 代码门禁、PostgreSQL 与镜像构建通过 |
| Agent ACP Service | HTTP、ACP 请求、Run/Tool、模型和 MCP 边界 | 代码门禁、PostgreSQL 与镜像构建通过 |
| Runtime Controller | 生命周期 RPC、Docker、存储、Runtime 环境配置 | 代码门禁、PostgreSQL 与镜像构建通过 |
| Runtime Egress | 控制 RPC、存储、规则结果；无逐包/逐流 Trace | Linux 门禁、PostgreSQL 与镜像构建通过 |
| Antnest Runtime | MCP、Runtime 信息、Executor、托管 MCP | Linux 门禁与镜像构建通过；尚未创建验收 Agent |

每个子 agent 只写一个服务目录中的源码、测试和文档，不修改公共合同、其他服务、
Compose 或 Git。不得执行测试、构建、格式化、生成器、容器、网络和外部集成。
协调者负责跨服务文档/配置、变更范围核对、格式化、依赖锁定及所有验证，重任务串行执行。
本轮授权不改变仓库平时的只读审查规则，不允许把并行写入扩散到共享目录。

不引入新数据库、新协议、重试、调度状态机或业务观测 Port。
Agent UI 仍是静态服务，不新增浏览器 tracing；未立项服务不启动。
各服务用已有 middleware/dispatcher、Transport、runner 和存储/执行器边界实现共同合同，
不得为了共享埋点导入兄弟服务的 internal 包。

## 验收顺序

1. 核对每个服务的真实差异和未覆盖项；子 agent 报告不是测试通过证明。
2. 协调者串行执行格式、标准 lint、受影响服务单测与组件测试；必要的 PostgreSQL
   测试使用隔离测试数据库，不重置人类验收实例。
3. 验证 HTTP/RPC 父子层级、返回错误自动采集、有意义的安全值、秘密 canary、预算、
   不完整内容、流式关闭/取消和禁用观测时的业务结果。数据库操作仍只属于本服务。
4. 统一脚本检查 Jaeger 的实际层级与诊断约束，而不是依赖某个手写 Span 名。
   异步操作使用原 operation ID 和 Links；不伪造同步父子关系。
5. 通过本地门禁后重建相关服务，保留当前开发实例业务数据和卷。按原约定，
   人类场景验收仍逐场景提供 Jaeger 链接，等待用户检查后继续。

## 可复用验证器

`scripts/observability/evidence.mjs` 检查指定同步 HTTP 场景：精确 SERVER 根、
CLIENT 到下游 SERVER 的直接父子关系、调用数量、Header/正文预算和秘密 canary。
不通过服务名共同出现来推断完整链路，不打印或持久化请求正文。
它不替代各服务的协议结果、异步 Link、数据库和执行器语义测试。

```sh
node --test scripts/observability/evidence.test.mjs
node scripts/observability/check-trace.mjs http://127.0.0.1:16686 TRACE_ID \
  '{"rootService":"edge-gateway","route":"/{path...}","status":200,"hops":[["edge-gateway","admin-console"]]}'
```

只记录最终门禁结果、服务缺口及 Jaeger 链接；不提交原始 Trace、秘密或过程转储。
“源码已改”“本地门禁通过”“业务场景已在 Jaeger 验收”分别报告。

## 最终代码门禁（2026-09-11）

| 验证 | 结果 |
| --- | --- |
| 根目录 `make fmt-check` | 通过 |
| 根目录 `make lint` | 通过；Go standard 0 issues；两个 Rust Clippy `-D warnings`；TypeScript lint/typecheck 通过 |
| 五个 Go 服务全包 `go test -race -p=1` | 通过；包括 Gateway 集成回归 |
| 根目录 `make test-node` | 全部通过；ACP 558 项，Console 96 单元 + 204 组件，Agent UI 45 单元 + 64 组件 |
| Jaeger 验证器及 Stage 2 断言 fixtures | 23 + 30 项通过，包含错误父子层级和跨语言属性类型反例 |
| Runtime Linux 构建阶段 | 144 单测 + 1 Executor CLI + 1 托管 MCP 示例测试通过，fmt/Clippy/发布构建通过 |
| Egress Linux 构建阶段 | 104 项通过，fmt/Clippy/发布构建通过；6 项 PostgreSQL 测试在独立 profile 执行 |
| PostgreSQL 集成 | 五个服务 profile 通过；ACP 160 项、Egress 6 项；测试共用一个临时 PostgreSQL，各用独立数据库/角色，结束后容器与卷已清理 |
| 镜像 | 本轮七个服务镜像均单独完成构建；未更改 Gateway、Agent UI 镜像 |

新回归不仅检查 Span 数量，还验证 HTTP-200 协议失败、上下文禁用导出后仍跨 await
透传、无提前读取流、EOF/取消、真实 SDK 接入、正常和异常响应的诊断值。
不存在通过缩小测试范围、放宽门槛或添加 `nolint` 换取通过的处理。

## 部署与 Jaeger 复核

当前实例 `antnest-dev-20260911`，入口 <http://127.0.0.1:8090>。六个常驻服务
已逐个替换为本轮镜像；Runtime 镜像已构建，留待创建 Agent 场景使用。
十个容器 running，九个有探针的容器 healthy；Jaeger 查询可用，重启计数均为 0。
七个应用服务使用 `diagnostic`，Runtime Controller 向后续新 Runtime 注入同一模式。
保留现有 PostgreSQL/Jaeger/卷。部署复核时未登录或创建业务配置；用户确认部署后，
已完成下一节的管理员登录检查，仍未配置模型、创建模板或 Agent。

| 请求 | 真实 Trace | 自动检查 |
| --- | --- | --- |
| `GET /status` | [Gateway 自身就绪](http://127.0.0.1:16686/trace/227ca8bb7a9c33d60ea126cd4f38d581) | 200；1 个 Gateway SERVER，0 次下游调用；1 项安全正文投影 |
| `GET /` | [首页代理](http://127.0.0.1:16686/trace/7463e8fff26dae5adc807315471d8f41) | 200；3 个 Span；Gateway SERVER → Gateway CLIENT → Console SERVER，两个直接 parent ID 均精确匹配 |

两次检查均通过统一验证器的字段类型、预算、合成 Authorization/Cookie/query canary
排除检查。首页是 HTML，不属于已登记的 JSON 业务正文，因此没有正文投影，这不是缺失
业务 DTO 的证明。未将这两个部署请求当作身份/模板/Agent 全链路已验收。
用户已确认部署并授权推进下一业务场景。

### 管理员本地登录

[登录场景记录](business-flow-local-admin-login.md) 已完成真实浏览器表单登录与刷新恢复、
Identity 自有数据库只读核对和统一 Trace 验证。登录根请求 HTTP 200，5 个 Span，
Gateway → Identity 一次调用，无下游 `/status`；刷新恢复不重复签发令牌。
登录 Trace：[e70748e743b745c98fd513708d460dcf](http://127.0.0.1:16686/trace/e70748e743b745c98fd513708d460dcf)。
当前等待用户检查本场景，再进入模型配置。

## 尚未宣称完成的部分

本轮是统一服务边界改造，不是整个埋点规范的无条件全量验收：

- 管理员登录 Trace 已自动核对、待用户检查；模型配置、模板及 Agent 创建仍未推进本轮验收。
- Collector 故障、队列饱和、长流并发内存/负载及生产诊断到期/留存尚无本轮完整压力验收。
- SDK 在处理器分发前拒绝的 MCP/ACP 请求，暂不保证每个协议错误都具有完整语义诊断；不另写协议解析器补造证据。
- Runtime 托管 stdio 的工具调用有 CLIENT Span；启动 initialize/catalog 交换和第三方进程自身 SERVER Span 不保证完整。
- Agent Controller 的既有后台业务观测、ACP recovery 的旧采集耦合及少数旧错误原因丢失仍存在，未扩大本轮范围为业务流程重构。
- 请求/响应正文只投影已登记的安全字段；流式内容、模型文本、工具正文、凭证及未知结构不抓取。

各服务的 `docs/observability.md` 描述其精确边界和剩余限制。后续业务 Trace 的通过
不能替代上述压力、故障和协议前置拒绝验收，单测通过也不等同于这些场景已通过。
