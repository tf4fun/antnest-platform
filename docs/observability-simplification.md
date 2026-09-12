# RPC 正文采集收敛清单

> 2026-09-11，依据用户确认的 [埋点规范](observability-contract.md)。
> 范围仅观测实现，不改变产品协议、业务数据和原验收实例。

| 批次 | 服务/内容 | 状态 |
| --- | --- | --- |
| 1 | Gateway：移除普通 HTTP 正文和 Header 值采集，保留链路及流式生命周期 | 单测、lint 通过 |
| 2 | Identity：已有 RPC 统一原对象采集与布尔开关；OIDC/SCIM HTTP 仅基础记录 | 单测、lint 通过 |
| 3 | Console：HTTP BFF 仅基础记录，删除逐 DTO 观测投影 | 单测、lint 通过 |
| 4 | Agent Controller：控制 RPC 正文；事件流仅基础记录 | 单测、lint 通过 |
| 5 | Runtime Controller：控制 RPC 正文、Runtime 开关注入；Docker/观测流不采正文 | 单测、lint 通过 |
| 6 | Egress：控制 RPC 正文，数据面不变 | Linux 104 测试、Clippy、镜像及 6 项 Postgres 集成通过 |
| 7 | Runtime：单次 MCP 请求/返回原对象；HTTP/stdio 通知流仅基础记录 | Linux 140 单测 + CLI/fixture、Clippy、镜像构建通过 |
| 8 | ACP：单次 RPC 原对象；模型/进度/会话通知等流不采内容 | 558 单测、lint/typecheck 通过 |
| 9 | Compose、配置示例、共享验收器、串行门禁及开发部署 | fmt-check、lint、test-node、12 个 Go 包 race 通过；七服务镜像更新，开发链路复核通过 |

旧 [观测改造报告](observability-rollout.md) 和 [登录验收](business-flow-local-admin-login.md)
仍是旧白名单实现的历史证据，不覆盖新采集策略。各批次完成后更新状态并记录最终结果。
正文可能含秘密，不打印或保存原始 Trace；联调使用合成凭证并仅输出断言结果与 Trace ID。

## 最终联调结果

开发项目 `antnest-dev-20260911` 保留原有数据卷。七个受影响服务已串行构建并替换，
Runtime 镜像也已通过 Linux 门禁并更新；本轮未创建 Agent、调用外部模型或进行浏览器验收。
部署级开关统一开启，默认示例仍为 `false`。

| 请求 | Span 数 | RPC 正文事件数 | Warnings | 结果与 Jaeger |
| --- | --- | --- | --- | --- |
| Gateway `/status` | 1 | 0 | 0 | 仅本服务，[Trace](http://127.0.0.1:16686/trace/159d59fe8847698ebe8f4a1e75d6a778) |
| Console 首页 | 3 | 0 | 0 | Gateway SERVER → CLIENT → Console SERVER，[Trace](http://127.0.0.1:16686/trace/ec6ac5dc01d32594f59bec0a3c5ac59d) |
| 管理员本地登录 | 5 | 2 | 0 | 等待 6 秒后仅查询一次；Identity 仅被调用一次；RPC 请求/结果只在接收边界各记录一次，[Trace](http://127.0.0.1:16686/trace/790ea90ed3f66df447ac11fa651ea3d8) |

三条链路均通过父子关系与无 Header 值采集断言。登录额外验证了合成密码及返回令牌没有被过滤，
但不在本报告保存其值。Jaeger 异步导出会短暂出现不完整树，使用下述修正后的查询流程验收。
Postgres 集成使用独立测试库和与 Compose 相同的 `.env`；六项测试无跳过，全部通过。

流式取消、背压、关闭/异常与开关关闭不序列化由本轮服务回归覆盖；上述三条开发链路不代表
模板创建、Agent 创建和完整聊天业务验收已完成。等待用户复核后继续原场景计划。

## Warning 漏检修正

用户发现旧登录 Trace `7e4da6109e22bb4f844a8571e8e213e9` 有四条相同 warning。
其父 Span `14b608692b94748b` 实际存在，是 Gateway 出站 CLIENT；树结构完整不代表没有告警。
旧验收器未检查 Trace/Span `warnings`，因此旧登录和 Console 结果不再作为合格验收证据。
旧记录保留，不删除或过滤其 warning。

在当前 Jaeger 2.20.0 内存部署上，用无业务内容的独立 OTLP 样例复现：

| 输入与查询顺序 | 最终 Span 数 | Warnings |
| --- | --- | --- |
| 先发 child，普通查询两次，再发 parent | 2，parent 已存在 | 2，旧告警仍保留 |
| child 与 parent 都入库后首次普通查询 | 2 | 0 |
| 先发 child，raw 查询两次，再发 parent，最终普通查询 | 2 | 0 |

官方 [内存存储](https://github.com/jaegertracing/jaeger/blob/v2.20.0/internal/storage/v2/memory/tenant.go)
返回存储中的 trace 对象；[clock-skew adjuster](https://github.com/jaegertracing/jaeger/blob/v2.20.0/cmd/jaeger/internal/extension/jaegerquery/internal/adjuster/clockskew.go)
在缺少 parent 时追加 warning。普通查询未收齐数据所造成的 warning 不会在 parent 后到达时自动清除。

以上 raw 对照组用于定位问题，不再作为当前验收流程。按用户确认，验收工具改为先等待 6 秒，
再做一次普通查询并检查父子关系、正文边界和零 warning；没有 raw 查询或自动轮询。
固定等待不是完整性保证，数据未齐或有告警仍报错，稍后可重新执行验收。
29 项回归测试及脚本格式检查通过，覆盖 warning 漏检、等待时长与先后顺序、单次查询、缺失 Span
和 API 错误。真实登录验收测得首次查询延迟 6000 ms、查询次数 1、5 个 Span、零 warning。
`make test-node` 已纳入查询测试。
没有修改业务埋点、关闭时钟检查或强制同步导出；没有修补 Jaeger 本身。
当前版本的 UI 若仍在 Span 未收齐时普通查询，依然可能触发同类上游残留行为。
