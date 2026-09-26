# Temporal 单节点重启地址稳定性

本批属于阶段四前依赖回归，范围仅为当前单节点 Temporal 的部署配置。
四个 server role 位于同一容器，内部成员发现必须在正常 stop/start 后仍使用
同一可达地址；外部 Controller/SDK 继续通过 `temporal:7233` 连接 frontend。
现有真实成员就绪检查、正常信号退出、业务恢复和调用链要求不变。

`matrix-05` 的正常重启发生 ringpop bootstrap 失败并退出。
`matrix-06` 的诊断捕获同一容器的广播地址从 `192.168.214.7` 变为
`192.168.214.4`，bootstrap 同时读到旧地址，30 秒加入超时后再次发现才恢复。
这证明了当前部署的地址漂移与失效种子窗口；首次 fatal 的完整启动日志不齐，
不能证明它与第二次重试每一步完全相同，也不能用一次复测通过称作修复。

部署合同选择 `TEMPORAL_BROADCAST_ADDRESS=127.0.0.1` 固定同容器内部通信；
`BIND_ON_IP=0.0.0.0` 保持外部 frontend 可达。该配置只适用于本仓的单容器
全部角色部署；未来拆分角色或横向扩容必须改成各节点之间实际可达的广播地址。
不修改上游代码、成员数据库、业务超时，也不增加启动睡眠或忽略健康检查。

官方将广播地址定义为其他 Temporal 服务可以到达的地址，见
[上游说明](https://github.com/temporalio/temporal/issues/2630)；
[1.32.0 成员发现实现](https://github.com/temporalio/temporal/blob/v1.32.0/common/membership/ringpop/monitor.go)
使用数据库中的近期心跳选择 bootstrap 节点。
多网卡监听的 [#9683](https://github.com/temporalio/temporal/issues/9683)
仅作为调查参考，本轮日志实际显示 wildcard gRPC listener，未认定是同一缺陷。

验收顺序：先复现部署合同失败，再通过本地部署/就绪合同，最后运行实际全栈
正常关停与其余恢复矩阵。必须验证初次启动和重启后各角色的实际心跳广播地址，
并保留创建/删除 Workflow、同 Session/Runtime/工作区恢复与远端流结束断言。
原始失败、诊断日志和环境核对留在 `artifacts/verification/dependency-refresh-20260926/`。

状态：`temporal-membership-red` 先复现缺失配置的合同失败；配置修正后
`temporal-membership-local-01/02` 的 20 项部署/就绪及 70 项关停证据检查通过。
本地组件首次被沙盒回环端口限制拦下，原始失败保留；允许本地网络后通过。
镜像保持不变。`matrix-07/lifecycle-shutdown` 已通过：实际日志确认初次启动和
同容器重启的四个角色都广播 `127.0.0.1`，bootstrap 重试均为零；10 个平台服务
正常退出并恢复原容器，Session/Runtime/工作区/事件历史保留，创建及删除 Workflow
完成。6 条调用链结构通过，7 个预期关停取消错误 Span 与两种时钟告警值保留，
严格退出码仍为 2。资源、保留环境和候选镜像比较无变化。

本批地址稳定性修复通过所属部署合同和实际跨服务关停门禁；后续完整恢复与浏览器
矩阵记录在依赖更新总文档，不以这一项代替整体平台回归。
