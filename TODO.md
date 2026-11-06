# Antnest Platform 全局 TODO

本清单保存全部开放 issue 的推进顺序、依赖、当前批次和验收记录。
按回归基线、共享契约、入口与身份安全、执行可靠性、产品能力、非交互执行与调度推进。
Issue 状态最后核对于 2026-10-28：141 个 issue，87 个已关闭，54 个开放；开放项包含 4 个 Epic（#82–#85）和 50 个执行项，全部已挂到对应 Epic。

## 执行约定

- 协调者选择批次、定义契约和测试、review 所有修改，独占 Git、网络、Docker、浏览器、验证与合并操作。
- 子 agent 使用 `gpt-6.1-sol`、`max` reasoning、独立上下文；任务只传必要的 issue、文件与约束，返回简短交接。
- 子 agent 可以只读调查。写入任务必须只有一个明确且互不重叠的写集合、一个机械变换；不运行测试、构建、生成器、Docker、网络或 Git。
- 只关注我们内部服务的代码逻辑；确认属于外部 SDK 的问题一律放过，保留诊断但不作为修复或合并阻塞，不追加 SDK 专项调查、证明或绕行实现。此为用户于 2026-10-17 新增的全局规则，取代此前仅暂缓亚毫秒 SDK 调查的范围。
- Span／Trace 采集与检查只作为辅助诊断，不作为 CI、阶段交付或合并阻塞（用户于 2026-10-21 新增）。保留原始证据和告警；不再因时序、父子关系、缺失 Span、采集器 HTTP 等 Trace 结果延迟交付。业务结果、权限／撤权、持久化、Runtime 执行与取消、容量时延、资源清理仍须独立通过；不能把未执行的业务检查追认为通过。此规则取代历史记录中的严格 Trace 准入要求。
- 每批遵循共享契约、单个服务的测试/实现/文档、消费方批次、显式集成验收的顺序。新行为先有失败测试。
- PR 合并门禁仅使用远程受影响服务的 unit、contract、component 与必要清理检查；main 是系统集成分支，合入后独立触发 E2E，结果不阻塞其他 PR 合并（#361，用户于 2026-10-28 确认）。本地仅做定向反馈，不重复完整 CI；协调者核对精确候选的远程证据后合并。
- Docker E2E 场景维护、执行、验收与失败跟进由专门流程负责，不属于开发代理职责（用户于 2026-10-30 明确）。除非用户另行明确指派，不主动新增／维护场景、安排／运行、等待／轮询或接手其失败，不将未完成 Docker E2E 列为开发代理后续待办或服务开发／PR 交付未完成项；需要时只交接相关上下文。服务 unit、contract、component 门禁（含 Docker 支撑的 PostgreSQL／Temporal 组件检查）仍照常负责，显式集成批次限必要的契约／组件集成与交接；不修改现有 CI 触发方式、放宽发布判据，也不把未执行 E2E 算作通过。此职责划分覆盖历史记录中的代理 E2E 待办表述。
- 合并前核对 GitHub closingIssuesReferences，子批次不得自动关闭仍有消费方或集成待办的父 issue；平台关联误关闭时核对事件来源后纠正。合并后记录 PR、commit、验证证据并更新复选框，并同步更新 issue #82 及相关子 issue 的交付进度、验收复选框、CI 证据与剩余工作。生产方完成但消费方或集成待交付时，issue 保持开放。
- 验证日志、截图与 CI 产物是临时调试输出而非永久档案：`artifacts/verification/`（Git 忽略）只保留当前批次最小日志，远程 PR 证据确认后即删除；唯一未提交代码备份（patch/diff、唯一恢复源）单独保存；测试源、fixtures 和清单遵循 [AGENTS.md](AGENTS.md)，均不存放在 `.cache/`。
- 开始下一项前读取本文件的当前批次、相关阶段和依赖，并重新核对该 issue 的正文、讨论与当前代码。

## 当前批次

- **main E2E 通知恢复回修（2026-11-06，PR [#555](https://github.com/tf4fun/antnest-platform/pull/555)）**：基于 main `4ea9027a` 跟进 [run 42143094709](https://github.com/tf4fun/antnest-platform/actions/runs/42143094709)；20 个 system 分组中 19 个通过，仅 ACP restart and response loss 的 `c-acp-restart-notify-ui` 失败（以实际 catalog／run 为准，纠正旧记录的 19 分组计数）。原产物排除了私有浏览器异常，先补安全错误类型／受限公开源码行号摘要，保留私有原始观察。定向 Chromium 复现成员登录自动 `location.replace('/workspace/')` 与原会话导航竞争：旧直接导航 RED 为 `net::ERR_ABORTED`；候选先等待登录跳转完成，再打开同一原 Session，成员跳转中／已完成及管理员不跳转三例 GREEN，原业务／通知／权限／唯一 Rebuild／清理断言保留。恢复与诊断 fixtures 292/292、定向格式／diff 检查通过。代码候选 `7056a405` 的 [Repository](https://github.com/tf4fun/antnest-platform/actions/runs/42159547829)／正式 [Integration](https://github.com/tf4fun/antnest-platform/actions/runs/42160368795) 均通过；[system run 42159547828](https://github.com/tf4fun/antnest-platform/actions/runs/42159547828) 的重启／自动恢复／管理员 UI／成员通知 UI／响应丢失五例业务通过，完整 20 分组仍在运行。原代码在独立远程诊断 run `42159327328` 连续三次通过，未重复原始失败，故不声称已证明历史异常与该竞争完全同因。本次后续提交仅更新交接记录，E2E 源码不变；不宣称 main E2E 或发布能力通过。本地重放因文件读取权限及缺 `/dev/net/tun` 未进入业务，资源已清理；未更改工作区权限或主机设备。临时证据在 `artifacts/verification/main-e2e-42143094709/`；独立诊断分支仅复跑通知场景，不进入交付 PR，也不替代完整门禁。
