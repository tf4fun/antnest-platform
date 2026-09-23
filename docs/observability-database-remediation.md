# 数据库自动埋点整改与推广

> 更新：2026-09-12。范围：Agent Controller、Identity Service、Runtime Controller、Runtime Egress。
> ACP 执行端保持冻结。本报告描述已经落实的数据库边界改造，不代替全部产品场景验收。

## 1. 改造原因

原来的 `replay_provider_request`、`create_provider_connection` 是人工命名的 Repository 方法 Span，
不是表访问 Span。新增方法需要记得补包装，维护责任分散，漏埋点也不会被编译器发现。
现在保留原有 SQL、事务、幂等检查和业务错误，移除这些逐业务方法包装。

SQL 的执行记录由驱动或私有数据库适配器自动产生；业务语义仍由入口 RPC 的请求与返回值说明。
一个方法访问几张表、执行几条 SQL，以实际驱动调用为准，不从业务方法名猜测。

## 2. 目标树形结构

```text
HTTP/RPC SERVER
  SELECT                         非事务查询
  postgresql transaction         INTERNAL，同一个 Trace，不另起 Trace
    BEGIN                        CLIENT
    SELECT / INSERT / UPDATE     CLIENT
    COMMIT 或 ROLLBACK           CLIENT
```

保留实际连接与 batch 包裹层；关闭 prepare 和 pool.acquire 的独立 Span。
这只关闭采集钩子，不改变 PostgreSQL 预编译或连接池行为。SQL 标题保留 SDK 默认 OP，
不为展示表名引入 SQL 解析器、手工字符串提取、额外数据库查询或业务名称字典。
事务包裹 Span 表示技术生命周期，名称不含业务方法、Agent ID、请求 ID 或表实例。
`antnest.transaction.outcome` 区分已提交、已回滚、失败或未确认。

SQL 保留 `db.query.text` 和标准数据库属性；不采集绑定参数或返回行。
SQL 中本就写入的字面值、Go 驱动记录的错误信息仍可能包含敏感内容，这不是数据库脱敏方案。
RPC 原文是否采集继续只受既有开关控制，消息流和 Egress IP 数据面不增加正文采集。

## 3. 四个服务的实际落点

| 服务 | SQL 采集 | 事务生命周期 |
| --- | --- | --- |
| Agent Controller | 生产 pool 和 LISTEN 连接统一安装 `otelpgx v0.12.0` | 私有 pool 返回持有上下文的事务句柄 |
| Identity Service | `ParsePoolConfig` 安装同一驱动 tracer | 原有事务入口使用私有事务句柄，迁移同样接入 |
| Runtime Controller | `OpenDatabase` 配置 pgx stdlib tracer，查询池和锁池一致 | Connector 包装原生 `driver.Tx`，包含自动回滚 |
| Runtime Egress | 私有 Client/Transaction 统一包装实际 tokio-postgres API | 事务自身持有 Span；显式完成与 Drop 分开记录 |

Go 驱动没有记录中的父 Span 时，不为启动、空闲轮询的每条 SQL 创建新 Trace。
Agent Controller 生命周期改由 Temporal SDK 传播同一业务 Trace，SQL 属于对应 Activity；
其他服务尚未迁移的后台 attempt 仍按其既有上下文记录。
没有数据库的服务不需要为了统一形式增加存储埋点。

各服务独立持有实现，不导入兄弟服务 internal，不建设新的全能公共观测框架。
新的查询只使用既有 pool/client，无需增加 Repository 方法包装；新的数据库原语在本服务私有适配器统一接入。

## 4. 实施中遇到的问题

### 自动回滚不是业务调用

仅在外层 `sql.Tx.Commit/Rollback` 后结束 Span 不够：
`database/sql` 会因取消直接启动驱动回滚；外层收到 `ErrTxDone` 也不代表驱动已经完成。
因此 Runtime Controller 将收尾放在原生 `driver.Tx`，不加回滚重试或额外后台任务。
确定性测试让原生回滚阻塞，证明“没有显式清理、重复 Rollback、取消后的 Commit”均不会提前结束 Span。

### 原始上下文必须保留

事务只替换查询的 Span parent，保留调用方 deadline、取消信号和其他 context 值。
没有有效事务 Span 时，必须保留后续查询传来的有效 parent，不能用 noop Span 覆盖。
正常提交后的 deferred Rollback 不得再导出一个事务结果。

### 未确认不等于成功

Rust 原生 Transaction Drop 只排入回滚请求，不等待数据库确认。
观测不得为此新开线程、补查或改变清理行为；只能记录 `unconfirmed`。
事务结果只在最终完成或 Drop 时写一次，避免同名属性同时出现“未确认”和“已提交”。

### 测试也可能假通过

测试 exporter 必须先安装，再构造绑定 tracer 的生产连接池。
否则后续测试可能拿到已经关闭的 provider；只遍历已有 SQL 的断言会在零条 SQL 时通过。
现在正常事务要求存在 BEGIN、正文 SQL、结束 SQL，同时检查 Trace ID、父子关系和事务时段。
业务返回值、幂等重放和数据库最终状态继续独立断言，不用“有 Span”代替业务正确性。

### 不把预编译误读成执行

登录验收中，20 个 Span 包含 8 次实际 SQL、6 个同名 prepare 子 Span、2 个 pool.acquire、
1 个事务与 3 个 HTTP Span。原来按标记排除 prepare 的计数虽然正确，但展示仍然误导。
Go 适配器现在只暴露 Query、Batch、CopyFrom、Connect 钩子，保留 SDK 默认名称、错误、SQLSTATE
和事务层级；新的回归断言直接拒绝 prepare/acquire 噪声，不仅是在计数时忽略它们。
pgx 的 StatementDescription 只提供参数类型和结果列信息，部分结果列带 TableOID；
查询 tracer 没有编译后的语法树，不能从这些信息完整恢复访问表集合。本轮撤销表名推导方案。

### 验收脚本不是缓存

复用脚本放在 `tests/support/verification/`，包含说明和自身测试；`.cache` 只存构建缓存。
现有 Trace 断言改为“精确 RPC SERVER + 技术数据库后代”，拒绝旧业务 wrapper、断链和异服务父节点。
Jaeger 查询仍在请求完成后等待六秒，再查询一次；不吞掉 warning，不修改服务导出行为。

## 5. 推广步骤

1. 在服务生产数据库构造入口安装驱动采集，覆盖普通连接、专用连接和重连。
2. 在数据库事务边界创建包裹 Span；优先利用驱动钩子，不能依赖每个业务方法自行创建或结束。
3. 移除逐 Repository 方法的名称字典与重复包装。保留真实异步工作单元的 Span。
4. 用生产构造器验证普通查询、提交、回滚、提交失败、取消、重复清理和无记录父上下文。
5. 回归锁、LISTEN、批处理、幂等与业务终态；参数和结果行不能意外进入 SQL 属性。
6. 串行执行格式、standard lint、完整受影响模块测试及实际 PostgreSQL 用例。
7. 重建对应服务后，通过 Gateway 发起业务请求，确认同 Trace、正确层级、零 warning，再交人类审查。

## 6. 验证范围

本轮最终代码验证（均由主 agent 执行）：

| 验证 | 结果 |
| --- | --- |
| Agent Controller 完整 race + PostgreSQL | 425 测试、368 子测试通过，0 跳过 |
| Identity Service 完整 race + PostgreSQL | 143 测试、59 子测试通过，0 跳过 |
| Runtime Controller 完整 race + PostgreSQL | 181 测试、141 子测试通过；只读 Docker opt-in 用例另行通过 |
| Runtime Egress | 普通完整测试通过；3 个事务原语 + 7 个 PostgreSQL 集成用例全部通过 |
| 修改涉及的 Node 验收脚本 | 543 测试通过，0 跳过 |
| 根级准入 | `make fmt-check lint` 通过，standard golangci-lint 0 issues，两个 Rust Clippy 均使用 `-D warnings` |

四个服务已重建并应用到 `antnest-dev-20260911`，均为 healthy；保留原数据库和 Provider，ACP 镜像未替换。

降噪回归过程中，Agent Controller 首轮全量运行的两个生命周期场景曾报告重建未收敛。
随后原始 tracer 与执行专用 tracer 的同条件单次对照均通过，最终完整 race/PostgreSQL 回归也通过；
本轮没有修改业务代码、延长测试超时或缩减范围。首次失败的根因尚未确定，不能将其宣称为已修复的业务缺陷。

- [管理员登录实际链路](http://127.0.0.1:16686/trace/e2f6403eee8555e8f702d6c047b0c0cf)：20 个 Span，1 个 INTERNAL 事务，8 条 SQL 执行记录（7 条在事务内、1 条在事务外），事务结果为 `committed`，0 warning。
- [Provider 只读查询链路](http://127.0.0.1:16686/trace/7c180ab71febd487663c64b839c62478)：16 个 Span，Gateway → Identity / Console → Controller 的真实父子关系完整，Controller 的 1 条 SQL 直接归属其 SERVER，不虚构事务，0 warning。
- 上述两条链接是降噪前的基线，包含 prepare/acquire，不能作为最终降噪验收。后续真实链路应不再包含这两类 Span。
- [降噪后管理员登录链路](http://127.0.0.1:16686/trace/f07f6ff96cd0d4a1ea1014f253b0d568)：三个 Go 服务已重建。登录 Trace 从 20 个 Span 收敛为 12 个，仍是 8 次 SQL（7 次位于唯一的已提交事务内），prepare/pool.acquire 均为零，Jaeger warning 为零。标题保留 SDK 默认 OP，未引入 SQL 解析或额外数据库查询；验收临时登录会话已退出。
- 验证没有调用外部模型、创建模板或 Agent；临时登录会话已退出。后续业务场景继续等待人类确认。

Runtime Controller/Egress 的真实上游业务 Trace 随后续 Agent 场景核对；本轮没有为制造 Span 发起额外生命周期操作。
四个服务的数据库回归不代表被冻结的 ACP 端或所有跨服务产品场景已经重新验收。
当前聊天链路以 Gateway 收到的单条 ACP 消息为业务 Trace 起点；异步 Run 继承该消息的 Trace，
不另起执行 Trace。长期 WebSocket 握手仅通过 Link 关联，不作为整段会话的父 Span。
这一区分以消息和连接的生命周期为依据，不能因异步执行而割断同一业务请求的父子关系。

## 7. Egress SQL 语义对齐复验（2026-09-12）

上一版 Rust 私有驱动包装已解决逐 Repository 漏埋点问题，但标题仍暴露
`postgresql query_opt/execute` 等 Rust API 名，数据库名固定为 schema，错误只输出
固定摘要。现已在同一个 Client/Transaction 边界修正，业务调用不增加埋点代码：

- 单语句取 SQL 起始操作词，保持与 Go otelpgx 默认 OP 一致；不做表名推导、AST
  解析或额外查询。多语句原生批调用记为 BATCH，事务原语为 BEGIN/COMMIT/ROLLBACK。
- 原 SQL 来自原生调用参数，连接元数据来自 tokio-postgres Config；数据库名不再写成
  schema。多候选连接地址不猜测最终目的地，不采集 DSN、绑定参数或结果行。
- 原生错误、SQLSTATE 和 typed DbError 详情自动写入异常事件，保留原 Result；不再
  用业务错误字典替换诊断。数据库错误可能回显值，遵循已批准的开发采集策略。
- 原有连接池、时限、重试和事务完成语义不变，IP 数据面依然不产生 Span。

真实 PostgreSQL 10 项、完整服务测试、126 项观测脚本测试与根级准入通过。新 Egress
镜像已更新。[最终 Trace](http://127.0.0.1:16686/trace/08e698fc4975c209da3a2c84d32862db)
包含 21 Span：四次跨服务调用各一次；Egress 四次事务外读取及一个已提交事务，事务内
为 BEGIN、三次 SELECT、COMMIT；零 warning。第一次脚本将事务外查询误算进事务内，
已根据父 Span 修正，未删除查询、放松父子断言或修改业务来匹配测试。

新复用脚本是 `tests/e2e/observability/exercise-egress-database.mjs`，不放 `.cache`。
它提交相同策略、核对持久化值不变，不代表数据面无副作用：现有应用路径可能重置流表。
对无扰动更新和重复读取的后续评审见[主流程时序文档](business-flow-trace-review.md)。
