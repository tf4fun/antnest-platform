# 跨服务可观测性与埋点规范

> 更新：2026-09-11。用户确认：客户端仅基础采集，单次 RPC 正文可开关，消息流不采集正文。
> 本版替代此前的 metadata/diagnostic、逐 DTO 白名单及客户端正文预算设计。
> 实现进度见 [收敛清单](observability-simplification.md)，不把目标规范当作已部署事实。
> 数据库边界整改与推广见 [实施报告](observability-database-remediation.md)。

## 1. 职责

Trace 用来核对真实调用关系、耗时、参数与返回结果、失败位置，不充当聊天存储或业务审计。
业务正常返回结果或 error；埋点安装在 HTTP、RPC、存储和执行器边界，不侵入领域模型。
不为观测新增业务接口、重试、状态机、可靠事件投递或数据库。

| 边界 | 采集 |
| --- | --- |
| HTTP/静态资源/代理 | 方法、路由、状态、目标、耗时、错误和父子关系；不采集 Header 值及正文 |
| 单次请求/响应 RPC | 基础记录；开关开启时采集已有参数和返回对象，不筛选字段 |
| SSE/WebSocket/模型输出/通知等消息流 | 基础连接、操作结果、取消与错误；不采集内容、不累积或拼接消息 |
| 数据库/Executor | 已有操作边界、关联 ID、结果与错误；不为采集补读数据 |
| Egress 转发数据面 | 不做逐包/逐流 OTLP；保留聚合指标与控制 RPC |

RPC 由已有协议适配器识别，不根据 URL 或 JSON 字段猜测。
例如 Gateway 登录 HTTP 只记录基本信息，Identity `local_login` RPC 可采集正文。
同一边界不重复增加 HTTP CLIENT/SERVER 与 RPC CLIENT/SERVER；优先复用已有 Span。
协议上有单独 dispatcher 的请求可以使用现有操作 Span；消息通知不因内部解码为对象而变成正文采集入口。
普通 HTTP 代理不抓取内部 RPC 报文，避免同一内容在每一跳复制。

## 2. 一个正文开关

```env
ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
```

- 默认不采集 RPC 正文；受控开发实例可显式设为 `true`。
- 开启后将整个已有 RPC 参数/返回值序列化到 `antnest.request` / `antnest.response` 事件。
- 事件使用 `antnest.payload.json`、协议方法及方向，不维护 DTO 字段白名单、嵌套脱敏规则或安全投影。
- 不对未知新增字段做默认删除，不另设固定 16 KiB、事件累计字节数或逐接口预算。
- 关闭时不序列化正文；采集失败不改变业务结果。不提前读取网络 Body，不缓存或聚合流。
- HTTP、流式协议不受这个开关影响，始终不采集正文。
- 此开关只控制正文；是否导出 Trace、采样、队列和 SDK 资源限制使用标准 OTel 配置。

完整指字段不被业务白名单删减，不承诺绕过 SDK、传输和接收端的标准容量限制。
不得将 SDK 截断后的 JSON 当作可用于业务重放的完整记录。
跨语言 SDK 的配置支持必须以实际版本为准；不另造远程配置中心或应用层限流框架。

开发原文可能包含密码、令牌、Provider 凭证和业务数据。
Jaeger 必须处于受控网络；正文不能再复制到普通日志或提交到 Git。
过滤、脱敏、采样、存储容量、留存和查询权限集中在采集/存储部署侧治理，后续使用标准组件。
集中处理不等于秘密没有离开服务，也不能恢复源头未采集或已截断的数据。

## 3. 基础链路

- 入站提取 W3C context 后创建 SERVER；出站先创建 CLIENT 再注入 context。
- 同步调用保持真实父子关系；后台 attempt 使用有界 root 和 Links，不悬挂已经完成的请求。
- 名称统一为 `HTTP <METHOD> <route template>` 和 `HTTP <METHOD> <target>`，不包含查询串、资源实例 ID 或正文。
- 保留已有 request/operation/Agent/session/run/revision ID；不以 Trace ID 替代业务幂等键。
- 服务身份使用 OTel Resource；指标不按正文或用户/Agent ID 建立无限标签。
- HTTP CLIENT 在响应读完、关闭或失败时结束；不能刚收到 Header 就结束流式请求 Span。
- 包装保留取消、背压、Flush、Hijack、双向传输及原始 error；观测不能修改协议结果。
- HTTP 200 中的 RPC error/MCP isError 由协议边界标记业务失败，不伪造 HTTP 状态。
- 导出关闭不等于停止上下文传播。标准 SDK 批量异步导出，导出失败不得改变业务结果。

### 数据库事务

数据库埋点使用技术边界，而不是 Repository 业务方法名。SQL 由驱动或私有数据库适配器自动记录；
事务单独使用 `postgresql transaction` INTERNAL Span，从原生 Begin 到实际 Commit/Rollback 返回。
事务内 SQL CLIENT 是该事务的子 Span；非事务 SQL 直接归属请求或后台 attempt。保留实际连接和 batch
包裹层；不为 prepare 或 pool.acquire 单独创建 Span，避免把预编译误读为重复执行。
事务结果使用 `antnest.transaction.outcome`。SQL 标题使用 SDK 默认 OP，具体访问内容查看 SQL 属性。
重复清理不能重复结束 Span，失败不能标为已提交，未确认的自动回滚不能宣称成功。
`database/sql` 的取消自动回滚必须在 `driver.Tx` 边界收尾，不能仅依赖调用方的 defer。
不新增 SQL 解析、表名猜测、额外查询或事务重试；SQL 文本保留占位符，不记录参数和结果行。

## 4. 健康检查

`GET /status` 只反映本服务初始化、停止状态及自有存储等必要本地依赖。
不递归调用其他业务服务的 `/status`。实际业务访问下游失败时，记录实际调用失败。
带上游 context 的请求保留正常 SERVER 层级；自主高频成功探针可以整条降采样。
Runtime 创建时的就绪等待属于业务流程，不是 Gateway 的健康聚合。

## 5. 验收

1. 真实 HTTP 证明 SERVER → CLIENT → SERVER 的直接 parent ID 与调用次数；无重复健康探测。必须同时检查 Jaeger 的 Trace/Span `warnings`，有 warning 不能仅因树结构完整就判定验收通过。
2. RPC 开关关闭时正文不序列化、不上报；开启时新增/嵌套字段和超过旧 16 KiB 的对象仍可被采集。
3. 普通 HTTP 与所有消息流即使开关开启也不产生正文；不新增读操作或破坏取消、背压。
4. RPC 错误响应、取消和异常仍被记录，采集错误不替换业务结果。
5. 不在新正文验收里断言秘密必须消失；开发原文的风险是本次明确接受的取舍。
6. SDK、导出和接收端异常测试与产品测试分别报告，不用“能看到 Trace”代替业务正确性。
7. 按服务完成 doc → test → code，再串行执行统一验收和镜像构建。
8. 只保留最终指标、缺口和 Jaeger 链接；原始内容不落仓库。

各语言保留薄采集组件，不导入兄弟服务的 internal，不建设全能观测框架。

### Jaeger 查询验收

开发环境 Jaeger 2.20.0 的内存存储存在查询副作用：对尚未收齐的 Trace 做普通查询，
clock-skew adjuster 会追加缺失父 Span 的 warning，父 Span 后到达也不会清除旧 warning。
自动验收在业务请求完成后先等待 6 秒，再做一次普通查询。等待和查询都只在验收脚本中执行，
不修改任何服务或 SDK 的导出配置，不做 raw 查询或自动轮询。
6 秒是当前默认 5 秒批量导出周期的验收缓冲，不保证数据必然收齐；仍需检查父子关系、正文边界
和零 warning。缺失 Span、API 错误或 warning 都必须报错，稍后可重新执行验收。
不得过滤 warning、关闭 clock-skew 或强制业务请求同步导出。
