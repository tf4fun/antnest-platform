# BF-AGENT-05 显式重建 Agent

> 更新：2026-09-12。当前实现：统一 Temporal 生命周期，task queue 为 agent-lifecycle。
> 本轮 Gateway API、业务终态、幂等重放和 Jaeger 核对已通过；等待用户审阅。
> 不把旧 PostgreSQL worker 的多 Trace 记录或此前浏览器验收当成本次证据。

## 1. 入口与输入

管理员从 Console 发起 `POST /api/admin/agents/{agent_id}/rebuild`，携带 Cookie、CSRF 和 Idempotency-Key。
Agent 标识、目标模板与 revision。受理阶段冻结目标 Spec 和源执行身份，锁住新 Run 准入。模板发布不会自动重建派生 Agent。

Gateway 认证操作者，Console 校验管理权限并组装组织范围请求；服务之间不直接访问对方数据库。
HTTP 202 仅表示意图已持久化，不表示运行资源已经处理完毕。

## 2. 受理时序

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 管理员客户端
    participant Edge as Edge Gateway
    participant Identity as Identity Service
    participant Console as Admin Console
    participant AC as Agent Controller HTTP
    participant Temporal as Temporal
    participant Worker as Controller SDK Worker
    participant DB as Controller PostgreSQL
    Admin->>Edge: POST /api/admin/agents/{agent_id}/rebuild
    Edge->>Identity: POST /rpc/identity/resolve-access-token
    Identity-->>Edge: 操作者身份
    Edge->>Console: 原请求 + 可信身份
    Console->>AC: POST /internal/agents/{agent_id}/rebuild
    AC->>DB: 查询既有幂等结果；命中则返回原结果
    AC->>Temporal: 新请求 UpdateWithStart，稳定 workflow ID
    Temporal->>Worker: admit_lifecycle Activity
    Worker->>DB: 校验、事务保存操作/Agent 状态/请求事件
    Worker-->>Temporal: 已提交受理结果
    Temporal-->>AC: admission Update 完成
    AC-->>Console: HTTP 202 + Agent/Operation
    Console-->>Edge: HTTP 202
    Edge-->>Admin: HTTP 202
    loop 按下面阶段表顺序执行
        Temporal->>Worker: 分派阶段 Activity
        Worker->>Worker: 调用下游 RPC，保存本阶段结果
        Worker-->>Temporal: 完成或返回可重试错误
    end
    Note over Admin,AC: 客户端通过独立事件订阅/查询感知完成；不是延长创建 POST
```

## 3. 阶段与持久化边界

| Activity 阶段 | 对外接口 | 工作与数据 |
| --- | --- | --- |
| drain | 无外部 RPC | 查询并等待原有 Run 结束；当前实机场景为空闲 Agent。 |
| network_fence | GET /internal/agent-networks/{agent_id}；PUT /internal/agent-network-attachments/{agent_id} | 读取附件版本，再确认业务阶段仍有效，CAS close，保存关闭结果。 |
| runtime_update | POST /internal/runtimes/{agent_id}/update | 传源 revision 和完整目标配置；Runtime Controller 替换容器、保留工作卷，等待新 Runtime ready。 |
| network_ensure | PUT /internal/agent-network-attachments/{agent_id} | 用保存的版本 CAS open，检查 Tunnel 坐标一致；不是重新分配地址。 |
| publish | 无外部 RPC | 单事务发布目标 Spec、ExecutionRevision、available、操作完成和 agent_rebuilt。 |

Controller 的 `agents`、`agent_lifecycle_operations`、`agent_events` 保存业务状态与审计。
Spec、ExecutionRevision 和访问绑定按上述业务步骤更新；Runtime Controller 和 Egress 各自持有平台/网络数据。
Temporal 保存工作流历史、调度和重试，不再使用业务库里的 claim、worker lease 或 recovery trace carrier。
阶段写入继续使用业务 CAS；下游复用确定的请求 ID / 资源版本，不能把 Activity 当成 exactly-once。

## 4. 当前验收证据

- 实例：`antnest-dev-20260911`；独立测试 Agent：`agent_2908b99c22e7174725f354880854d5c6`。
- [Gateway 完整 Trace](http://127.0.0.1:16686/trace/bad38570329dfc7a05573b386ece8c10)：239 个 Span，零缺失父 Span、零 Jaeger warning。
- 请求受理 HTTP 202，operation 最终 completed；目标 Agent 业务状态为 `available`。
- 同一幂等键重放未更改 operation 终态或事件历史。五阶段验收结束后，此测试 Agent 的容器与独占卷均已回收。
- 未调用外部模型、未执行 ACP Run，也未重做浏览器/UI 或 Docker SIGKILL 专项验收。

官方 SDK Workflow/Activity 均延续同一 Gateway Trace；顺序执行不代表让前一 Activity Span 包住后一 Activity。
事务/SQL 与确切的下游成功 SERVER RPC 必须归属对应 Activity。Docker 存在性检查可能产生真实 404；
不能因此虚报生命周期失败，也不能把零 warning 写成所有底层 HTTP 都无错误。

```sh
node scripts/observability/check-lifecycle.mjs \
  --kind rebuild \
  --admission bad38570329dfc7a05573b386ece8c10 \
  --request lifecycle-5bc54bd945caf931a05683f1957fb9d1e3e241da97f7694a0a222596dd9f8a6d \
  --agent agent_2908b99c22e7174725f354880854d5c6
```

命令等待六秒导出窗口后只读查询，不保留原始 RPC 正文或凭证。
完整测试、复核与统一合同见 [Lifecycle workflows](../services/agent-controller/docs/lifecycle-workflows.md)。
