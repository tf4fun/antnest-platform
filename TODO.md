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
- 合并前核对 GitHub closingIssuesReferences，子批次不得自动关闭仍有消费方或集成待办的父 issue；平台关联误关闭时核对事件来源后纠正。合并后记录 PR、commit、验证证据并更新复选框，并同步更新 issue #82 及相关子 issue 的交付进度、验收复选框、CI 证据与剩余工作。生产方完成但消费方或集成待交付时，issue 保持开放。
- 验证日志、截图与 CI 产物是临时调试输出而非永久档案：`artifacts/verification/`（Git 忽略）只保留当前批次最小日志，远程 PR 证据确认后即删除；唯一未提交代码备份（patch/diff、唯一恢复源）单独保存；测试源、fixtures 和清单遵循 [AGENTS.md](AGENTS.md)，均不存放在 `.cache/`。
- 开始下一项前读取本文件的当前批次、相关阶段和依赖，并重新核对该 issue 的正文、讨论与当前代码。

## 当前批次

- **#43 ACP 基础批次（2026-10-29，最新）**：契约 PR #395 与 Controller PR #396 之上的 ACP 消费方第一阶段——`src/domain/execution-publication-v2.ts`（严格 v2 schema：schema_version=2、Provider credential 仅 `{ref, version}` 并强制 ref=connection_id/version=credential_revision、ref 后调用 validateConfiguration 校验引用与唯一 ID；delta schema/解析含 revision>base、upsert/delete 去重与重叠拒绝；digest 响应 schema 缺席/当前互斥与 ID 唯一性；canonical JSON 排序键+U+2028/29 转义的公开文档摘要与根摘要）、`parseExecutionAuthority` 版本分发（无 schema_version→legacy，非 2→拒绝）、`reconstructExecutionDelta` 泛型 merge（保留未变私有授权含 Runtime token、budget null 移除）、`allowsV1ToV2Upgrade`（仅剥离 schema_version 与 Provider credential 深比较、Runtime 不动）。`ExecutionConfiguration` 类型为 legacy|v2 union；`publicExecutionConfiguration` 显式删除 schema_version 保持版本中立。ExecutionDirectory 新增 `applyDelta`（锁内核对当前 v2 私有授权 base_revision，否则 configuration_base_mismatch；重建后走原 applyCurrent+外部 beforeAck/beforePeerAck）与 `getDigest`（loadAuthority 缺席 vs 存储失败区分、缺失时走 applyCurrent 冷恢复、当前捕获无重复 onApplied、始终外部屏障后 assertCurrent 再返回）。PG 适配器 retainIdentities 仅对含 secret 的 credential 取指纹、等修订 UPDATE 守卫新增显式 upgrade 标志放行已校验升级。RuntimeConnections.prepare 改用版本分发解析。测试先于修复：新域/目录测试曾红（缺引用校验、schema_version 泄漏、delta 去重、digest 约束等真实缺陷），修复后全绿；PG 等修订升级/降级拒绝/重启恢复为根 integration 源码（本地无隔离库未执行）。第二阶段已落地：Provider 分发 ref 模式（Client mode/generation 栏栅、60s TTL/1024 上限惰性缓存、仅 complete 时惰性 resolve、释放/轮换/禁用/中止后陈旧响应不得分发或回填缓存）、`ControllerExecutionCredentialsClient` HTTP 适配器（bare origin、POST /internal/execution-credentials/resolve、combined 5s/64KiB 流界限、strictObject 重复键、全部失败统一 provider_unavailable 且无 canary/正文泄漏）、`ANTNEST_ACP_EXECUTION_CONTROLLER_URL`（learning 同 origin 必须精确匹配并共享单一 controller fetcher、可独立开启）与 composition 接线；transport 新增 `apply-execution-delta`/`get-execution-digest` 控制面路由（workspace 404、异工作负载 403、base_mismatch 409、未知错误脱敏 503、absent port 503）与 callers.json/errors.json 契约条目；`docs/execution-configuration.md` v2 消费方小节与真实 listener 回归测试 `test/transport/execution-publication-v2.test.ts`。证据 `artifacts/verification/issue-43-acp/`（基础期非 TDD 起步，缺陷/回归测试先红后绿；新路由回归在路由实现之后补充，无伪造红基线）。候选 PR 待提交，跨服务集成与远程 CI 验收 pending；不关闭 #43、不宣称系统完成。
- **#43 最终集成批次（2026-10-29，最新，fix/issue-43-integration）**：部署启用 v2——compose `ANTNEST_AGENT_CONTROLLER_EXECUTION_WIRE_VERSION:-2`、resync 30s→5m、`ANTNEST_ACP_EXECUTION_CONTROLLER_URL=http://agent-controller:8080` 与 `.env.example` 对应项（代码默认仍为 1，回滚=wire1+resync30s）；readiness 透明代理同时延迟 snapshot 与 delta 路径（digest 立即转发、无 ACK/retry 合成），attempt 元数据 schemaVersion/baseRevision、delta 绑定取自 agents.upserts，`publicationProof` 接受两路径且 delta 强制 schema2+base<revision，run.mjs 断言 schemaVersion===2；stage3-base 既有 credential rotation 现记录 `execution_credential_rotation` 工件（connection_id 不变、版本非空且不同）；`docs/provider-credentials-and-models.md` 增补 395/396/397 上线与冻结测量（不重跑）。独立 PR 证据：契约 #395、Controller #396+修复 e41f43ef、ACP #397；本批=源码+PR 交付，非 issue 验收——PG component 实际运行、双子进程竞态、main 上的 credential rotation 系统证据仍 pending 至用户通知远程结果，不关闭 #43。
- **#43 Controller 批次（2026-10-29，最新）**：契约 PR #395 之上的 Controller 生产方实现——`ExecutionSnapshot.SchemaVersion` 与 `ExecutionCredential` 的 `{ref, version}` 线形、版本感知 Validate、`BuildExecutionSnapshotV2`（不解密的引用投影）、`ExecutionV2Client`（get-execution-digest/apply-execution-delta，含 `configuration_base_mismatch` 映射与响应校验）、`WithExecutionWireVersion(2)` 发布流程（digest 快速路径记录已验证 ACK、远程新于本地判 invalid_response、仅 v2 落后时发 delta、缺席/legacy/等修订 full-v2、仅 base_mismatch 回退一次且不回退 v1）、公开投影 SHA-256 摘要与 delta 构造（移除 Provider credential 与 Runtime token、principal_ids 规范排序、排序键 JSON/最少转义）、容量守卫 wire 版本、`POST /internal/execution-credentials/resolve`（仅 agent-acp-service 工作负载、无 CCT、no-store、精确范围绑定后解密、404/409/503 映射与脱敏）、`ANTNEST_AGENT_CONTROLLER_EXECUTION_WIRE_VERSION`（默认 1；v2 默认 resync 5m，显式 interval 优先）、callers.json 与 control-contract.json（revision 46）登记。默认 v1 行为不变。PostgreSQL component 源含真实双子进程（os.Executable 子进程独立 Repository 共享 DB/ACP fixture）竞态测试——每修订仅一次读源与一次 apply/delta、跨组织互不限塞与取消清理；本地无隔离测试库未执行，已 vet 编译，远程 CI 验收。ACP 消费方、等修订 v1→v2 兼容校验、跨服务集成验收与远程 CI 均为后续批次；本批次不关闭 #43，不宣称业务工作流完成。
- **#43 共享契约批次（2026-10-29，最新）**：交付 v2 执行发布共享契约——`contracts/agent-acp/execution-publication-v2.schema.json`（snapshot/delta/digest $defs，Provider credential 改为 `{ref, version}` 引用、无明文，模型/Agent/budget 经外部 $ref 复用 legacy 约束）、`contracts/agent-controller/execution-credentials.schema.json`（resolve 请求/响应）、`execution-api.md` 的 #43 pending 小节（delta 应用、digest 语义、凭据 resolve 路由与 N-1 上线规则）及平台契约测试 `tests/integration/platform/execution-publication-v2-contract.test.mjs`（先红后绿）。legacy snapshot schema 与生成器不变作 N-1。ACP/Controller 服务实现与跨服务 delta/digest 集成为后续独立批次，本批次不改任何服务逻辑，不宣称业务工作流完成。
- **#390 冲突处理（2026-10-29，第二次同步，最新）**：按用户要求再次同步 main `ecb6739b`（期间并入 #393 真实协议验收与 #394 E2E fixture 修复），冲突仍仅为本文件当前批次记录的并发追加；保留双方全部条目和 `READY_PATH` 安全修复，不修改测试源码或服务逻辑。合并候选须重新核对精确候选的远程 Repository／Integration checks 与 CodeQL，旧候选通过不替代新候选证据。
- **#390 冲突处理（2026-10-29）**：按用户要求同步 main `3b4bd17e`，冲突仅为本文件当前批次记录的并发追加；保留双方历史记录和 `READY_PATH` 安全修复，不修改测试源码或服务逻辑。合并候选须重新核对远程 Repository／Integration checks 与 CodeQL，旧候选通过不替代新候选证据。
- **#390 CI 格式修复（2026-10-29）**：用户通知后核对独立 code-scanning PR 候选 `7b2eaf72`；Repository run `40831966513` 失败于 `go-service.test.mjs` 的 Prettier 检查。仅调整 fixture callback 的换行／缩进，保留 `READY_PATH` 环境传递、字符串内容与其他全部逻辑；受影响文件 Prettier 检查及 7 项 Go runner fixture 测试通过。未混入 #51 ACP／集成改动，未声称远程完整门或 code-scanning 已通过；推送后不等待或轮询新 CI。
- **#51 main system E2E 回归修复（2026-10-29，最新）**：#392 合入后 main `3b4bd17e` system-e2e run `40860466128` 失败于 Skill discovery、Skill learning、Workspace browser 与 Edge Gateway／Agent UI receipt 四个 job。证据：skill-deployment／discovery／source-lifecycle 的 Agent Run 返回 `context_budget_exhausted`（-32022）；skill-learning fake model 记录无 tools 请求未带 review 提示的断言失败（即 #51 摘要压缩请求）。根因是共享 fixture `tests/e2e/workspace-closeout/c4-setup.mjs` 与 `browser-current.mjs` 仍用 `context_window: 8192` 且无 tokenizer，而 #388 按文档契约对未设置 tokenizer 采用 UTF-8 字节上界（旧为 length/4），预算不足以容纳 Runtime tool schema 与指导，触发压缩或预算拒绝。仅修改 E2E fixture 为 65536（不改 ACP 生产估算），先红后绿补充两处 fixture 单测（5 项通过）；其余 Gateway／receipt 失败的 shard 日志未上传，按同一 fixture 归因，须 main system 重跑确认。修复 PR [#394](https://github.com/tf4fun/antnest-platform/pull/394)（候选 `12c19363`）用户确认远程 CI 通过后合并 main 解决 TODO 冲突，仅保留双方条目。
- **#51 替代验收交付**：独立集成 PR [#393](https://github.com/tf4fun/antnest-platform/pull/393) 已提交，功能提交 `9c8e6aa4`；本条仅补录 PR 索引，完整远程门待最终候选，不等待或轮询 CI、不提前勾选验收或关闭 #51。容器部署／版本集 system 验收仍独立保留。
- **#51 替代验收集成批次（2026-10-29，最新）**：用户明确选择真实协议＋PostgreSQL 集成方案替代原 Docker 200 轮条目，已同步 issue 正文并保留验收勾选为空。原 mock 回归不变；新用例使用官方 ACP v1 HTTP client、生产 OpenAICompatibleModel 的 prepare／实际 HTTP／SSE 路径及独立 Provider HTTP fixture，不 mock model.complete／fetch。200 轮实际请求逐一保留原任务，HTTP 400 overflow 只多一次 foreground 请求；另验请求预算 1 阻止重试、重复 overflow 终止、HTTP 摘要失败 fallback、持久 checkpoint pin／prompt version、所有物理请求的隐藏 start／finish 与 SSE usage／cost 归属，以及强制 teardown 前的原 transport 连接释放。旧 mock 接线的负向对照为 0 个真实 foreground 请求／345 次 mock 调用，明确失败；恢复 transport 注入后该文件 5 项定向测试通过（包含原 mock 回归），类型检查、三文件实际 typed lint（显式现有 TS project，零 warning）和相关格式检查通过。固定 usage／cost 仅证明协议和记账，不证明真实模型计数或摘要语义质量。独立集成 PR 待提交，完整远程门待精确候选；不把此 component 结果宣称为 Docker／版本集发布能力，不提前关闭 #51。说明见 `tests/integration/agent-acp-service/CONTEXT_ACCEPTANCE.md`，最小临时日志见 `artifacts/verification/issue-51-protocol-acceptance/`；旧的本地合并交接记录随本批次补交。推送后不等待或轮询新 CI。
- **合并状态补记**：时间线确认 #385 的自动关闭关联在合并时关闭了 #51；已恢复 OPEN 并记录四个合并提交，父 issue 继续等待独立系统验收。本次创建的 round3 临时调试输出已清理；更早轮次的文件未擅自删除。
- **#51 合并交接（2026-10-29，最新，以此项为准）**：用户确认 CI 通过并要求合并后，逐一核对精确候选 `14e2bc7a`／`d0140948`／`eefec80f`／`f4a96b2b` 的最新有效 Repository／Integration checks 均为 SUCCESS（integration runs `40856286443`／`40856287836`／`40856375405`／`40856483144`；不把旧取消运行或跳过项当通过）。按 Controller #385 → ACP #388 → Console #389 → 集成 #392 顺序保留历史合入 main，后续堆叠 PR 在前序合并后改为 main 目标；已复核四者 MERGED、base=main，合并提交依次为 `7044a704`／`1b64b619`／`993da73b`／`3b4bd17e`。合并凭据另记 #392 评论；未合并无关 #390，#51 不以 PR component 通过代替 main/version-set system 验收。未等待或轮询合并后 CI。此交接行暂存本地，未为记录更新直接推送 main 或改变已验证候选。
- **#388／#389／#392 CI 第三轮（2026-10-29，最新）**：精确候选 `aa2aa5d1`／`0b1651c0`／`5160ff32` 的 Repository 失败均为近上限图片用例仍按旧 base64 token 成本断言；已保留宽模型放行／小模型拒绝两侧检查，并显式提供 model／tokenizer metadata，12 项 workload 测试通过。ACP component 剩余两个旧 schema 比较已在独立临时 PostgreSQL 17.11、非特权 ACP owner 下复现，确认为新增 checkpoint 默认字段；历史 JSON 比较采用“默认字段在左、实际存储在右”，不屏蔽非默认值或旧字段变化，相关 6 项 PostgreSQL 测试全部通过。Identity component 旧产物仅报约 720s 后失败／cleanup 通过；依赖链缺少 main 已有的 `cf9eac90` Identity fixture 与 `01083ffa` Go 缓存／超时诊断修复，将同步 main 基线而不新增 Identity 生产变更、不放宽预算，仍须精确候选远程复验。最小日志在 `artifacts/verification/pr-388-ci-fix/round3/`；fixture 通过不代表完整远程／system 通过，推送后停止查询新 CI。
- **#388／#392 CI 第二轮（2026-10-29，最新）**：用户再次通知后核对候选 `9574c68f`／`4dca2c73`：Repository runs `40847771351`／`40847784575` 失败于 `test-cost-fixtures` 的旧 checkpoint SQL 合约，不是新一轮 ACP unit 失败；首次查看时 PostgreSQL component 仍在执行，不计通过或失败。已本地复现，再更新 Cost fixture／校验器的校准读取、首任务读取、checkpoint metadata 查询与写入合约；补充丢失组织隔离、首任务过滤和摘要 metadata 的负向回归，保留完整 SQL／归属／次序断言。`make test-cost-fixtures` 2046 项通过，受影响三文件 Prettier 检查通过；这只是 fixture 验证，不代表真实跨服务或 system 验收。日志暂存 `artifacts/verification/pr-388-ci-fix/cost-{red,green}.log`。#390 为独立 code-scanning PR，旧候选 `7b2eaf72` 的 Repository check 仅报 `go-service.test.mjs` 格式问题，将在其自身分支处理，不混入 #51。推送后不等待或轮询新 CI，未完成的 PG／完整远程门由用户后续通知。
- **#388 CI 修复（2026-10-29，最新）**：用户通知后核对旧候选 `e013dd36`：Repository run `40833734910` 的 observer 用例存在状态文件先于 private log 写入的竞态；integration run `40833735165` 报 ACP unit 5 项失败，PostgreSQL component 产物记录 9 条失败条目（含动态用例占位）、cleanup 通过。已先红后绿修复空／非 JSON／超大 HTTP 400/413/422 响应的原始 HTTP 分类和取消失败传播、Tool excerpt 已足够时不花费摘要调用、Plan 以 assistant 角色通过内部 metadata 固定保留（不进入 Provider wire）；相关 110 项 TypeScript 测试、受影响文件 lint、服务与集成 TypeScript 项目检查通过。observer 增加延迟写入的确定性竞态回归并等待完整双文件，18 项测试在本机 Python 3.13.12 通过（系统 Python 3.9 不支持既有 `Exception.add_note`，未改代码绕过）。PostgreSQL fixture 已更新 0033／0034 journal、降级时先移除新 view／checkpoint 列，以及 fork 使用复制后消息 ID；原产物缺断言 stdout，本地未执行 PG，不宣称这些业务门通过，交远程精确候选复验。最小旧候选产物暂存 `artifacts/verification/pr-388-ci-fix/component-evidence.zip`；修复推送后不等待／轮询新 CI，#51 保持开放。
- **#51 上下文管理（2026-10-29）**：按 Controller → ACP → Admin Console → 独立集成批次交付，每个服务独立 PR，不等待 CI、不自动合并或关闭父 issue。Controller 批次已定义可选 `tokenizer`（`o200k`／`cl100k`／`none`）与 `compaction_model_profile_id`，通过现有模型 JSON 持久化及 execution snapshot 透传；domain／application 定向测试已先红（unknown field）后绿。ACP 估算、校准、模型摘要、首任务 pinning、溢出重试，Console 配置和系统验收均待交付；远程完整门禁待 PR CI，不以定向本地结果代替。
- **#51 ACP 消费批次**：Controller PR [#385](https://github.com/tf4fun/antnest-platform/pull/385) 之后堆叠交付。ACP 已实现可选 tokenizer／摘要模型冻结、UTF-8 上界与有界分块 tiktoken、与 base64 长度无关的媒体预算、模型摘要和持久首任务 pin、完整 Tool 交换保留、无输出 overflow 一次重试及共享请求／费用／截止预算。127 项相关 unit 测试通过（新增功能先红后绿）；PostgreSQL migration、实际预算记账与组件门仍须远程 CI。校准复用不可变 attempt start／finish receipts，`model_token_calibration` 为最近 128 个有效样本的 p95 视图，而非重复写入的第二份账本；组织／profile／model／tokenizer 隔离。未知图像采用常规 OpenAI 8-tile 上界，非 OpenAI 特有图像公式未覆盖。Console 与独立集成／200-turn 中文系统验收待交付，#51 保持开放。
- **#51 Console 消费批次**：ACP PR [#388](https://github.com/tf4fun/antnest-platform/pull/388) 已创建，候选 `197d1a71`，不等待 CI。Controller #385 检查仅查看一次，run `40822949882` 的相关 unit／component／Integration checks 为 SUCCESS，未执行合并。Console 已补齐模型 metadata 的读投影、create／revise／provider models 语法校验、编辑／清除／保存和展示；定向 Go 测试、5 项浏览器参数 unit、5 项 React 组件测试、Web typecheck 通过。完整远程门禁待 PR；独立 200-turn 中文 HTTP＋PostgreSQL component 测试源批次随后交付，Docker／main system 验收不宣称已完成。
- **#51 最新交付索引（此前“待交付”记录为阶段历史，以此项为准）**：三个服务修改和独立集成测试源均已提交；依赖顺序为 Controller [#385](https://github.com/tf4fun/antnest-platform/pull/385)（`0a895578`）→ ACP [#388](https://github.com/tf4fun/antnest-platform/pull/388)（`e013dd36`）→ Console [#389](https://github.com/tf4fun/antnest-platform/pull/389)（`4b005d80`，正常合并上游修复，无历史重写）→ 集成 [#392](https://github.com/tf4fun/antnest-platform/pull/392)（测试源提交 `674a1d16`）。ACP 后续 TDD 修正包括专用摘要模型的持久 attempt 准入、按 token 限制 Runtime metadata、摘要／机械 fallback 的 15% 上限及 cleanup／deadline／ownership／persistence 错误不可触发溢出恢复；35 项相关 context／candidate 和 8 项 overflow／safety 测试通过，受影响文件 lint／format 通过。独立集成源覆盖 200 轮中文 HTTP＋PostgreSQL、每次 foreground 原任务保留、80 次成功后的一次 overflow、专用 compactor 实际调用、持久 checkpoint pin 与最近 128 个样本的 p95；集成 TypeScript 项目检查及该文件 lint／format 已通过，但 PostgreSQL component 尚未执行，不算通过。未合并任何 PR、未关闭 #51；完整远程门禁及 post-merge main/version-set system 证据仍待验收。所有服务提交后不再查询或轮询 CI，后续结果由用户通知。
- **ACP 学习恢复 Provider 观测漂移修复（2026-10-29）**：main system-e2e 自 `a2c1d24`（#372）起连续失败（#377 跟踪），`Skill discovery and deployment` 的 `service-authentication-integration`／`encryption-key-rotation` 均为 `automatic Skill creation notice: deadline exceeded`，任务停在 `paused / runtime_unavailable`，ACP 每 2s 记录 `skill_learning_recovery_failed`（脱敏为 `unregistered message omitted`）。根因：#372 使 Controller 在执行模型上发布 `provider_token_limits`／`supports_tools`，ACP Run 快照的 ModelSpec 已含二者，但 `LearningModelAuthority.currentModelSpec` 重建当前规格时遗漏，深比较必然不等而抛出 `Learning model or Provider authorization changed`。修复仅限 ACP：当前规格补齐两字段；先写回归（不变事实通过，移除／变更上限、凭据版本、Tool 支持均判漂移）。按用户约束未在本地运行测试，待远程 CI；修复不等于 main system-e2e 已恢复。

- **PR #381 zip 9 兼容修复（2026-10-29）**：远程 Integration run `40805728569` 的 Runtime 编译因 `ZipFile::name()`／`extra_data()` 返回类型变化失败。现保留 zip `9.0.5`，将名称解码错误映射为 `invalid_package`，并在已有中央目录边界检查中校验原始 extra 字节，避免重新序列化省略 NTFS／重复时间戳而放宽白名单。新增无效 UTF-8、允许时间戳、未知／NTFS／重复／截断 extra 回归；先复现编译失败及类型适配后的语义反例，再通过 7 项 ZIP 测试、fmt 和 all-targets clippy。原始日志临时保留于 `artifacts/verification/pr-381/`；修复已审查，待推送候选的远程 CI，不代表系统 E2E 或合并。

当前状态（2026-10-28，北京时间）。2026-10-28 之前的检查点日志已移出本文件：已提交部分见 Git 历史，未提交的 2026-10-22 至 10-25 检查点见 `artifacts/verification/issue-triage-20261028/TODO-current-batch-history.md`。

- **主线 #82 → #52**：#82 结构化子项 8/21 关闭（新挂入 #252、#356）；#52 原验收 1/5。#342 契约、#343 重试、#344 fallback、#345 熔断、#347 ACP 预算记账与执行（`6330f84b`）已合并；#347 只交付 ACP 生产方。
- **主线交付**：#52 Controller Template 策略 PR [#366](https://github.com/tf4fun/antnest-platform/pull/366) 已合并（squash `852a5215`，评审候选 `46b4b078`）；#52 原验收仍为 1/5，子服务生产方／消费者实现不等于完整业务验收。
- **Provider 观测**：PR [#372](https://github.com/tf4fun/antnest-platform/pull/372) 仍开放；`b227cd80` 修复测试编译，`96e801e6` 修复 staticcheck。已单次核对精确候选 `96e801e67f95a476d289e899e1df96c9f3d3cdef`：Repository、Controller unit、PostgreSQL/Temporal、Integration 必需检查通过（[run 40719354986](https://github.com/tf4fun/antnest-platform/actions/runs/40719354986)），closingIssuesReferences 为空；未执行合并。
- **组织预算生产方**：Controller PR [#374](https://github.com/tf4fun/antnest-platform/pull/374) 仍开放、堆叠 #372；GET/PUT、管理员鉴权、CAS／幂等 receipt、迁移 0034、策略与执行发布原子提交、正常 ACP Apply/ACK 已实现。精确候选 `0d569e7c` 的静态检查／格式问题已修复推送 `fd568471`；该候选另有 PostgreSQL/Temporal 业务失败（cleanup 通过）及 deployment shard 失败（cleanup 失败），现有产物缺断言 stdout，原因未确认，不能归因于已修复的样式问题。新候选远程结果未等待／未复查。本地聚焦 Go 通过，DB 依赖用例因无数据库跳过，Node ACP 契约检查因本地缺 ajv 未执行；均未计为通过。
- **Console 消费方**：PR [#375](https://github.com/tf4fun/antnest-platform/pull/375) 已创建、堆叠 #374；Template retry/failover/Run budget 与组织预算 BFF/UI、精确 USD 转换、零与缺省、CAS 冲突／重试主体隔离、admin contract 58 已实现。本地聚焦 Go、5 项契约、21 项 helper/routes、63 项组件及类型检查通过；原始日志临时保留于 `artifacts/verification/console-model-policy/verified-raw.log`。前序修复已同步，Console 自身远程 CI 未等待／未检查。
- **#374/#375 CI 修复（2026-10-29）**：按用户失败通知核对 `fd568471`／`2aa24c6c`。Controller 鉴权 fixture 漏装新路由造成 404，现补齐；共享 Go 路由扫描器仅按方法名匹配而混淆两个接收者的 `policyRoutes()`，现按本地接收者类型解析，未知类型仍 fail closed，增加三项回归。#374 修复已推送 `4be33db8` 并同步 Console；Console 审计契约测试遗留版本 57，现严格更新为 58 并覆盖新策略路由注册。聚焦 Controller 鉴权／边界检查与路由扫描器 24 项测试通过，Console 聚焦验证见本轮原始日志 `artifacts/verification/pr-374-375-ci-fixes/`。部署分片只返回退出码 2、现有日志无断言详情；没有据此宣称其业务／清理失败已确认修复。未等待／轮询新候选 CI；#52 与真实 Docker 验收保持未完成。
- **停止点与后续**：仅剩服务准入后真实跨服务 Docker 集成：429/503 retry/fallback、双 attempt 审计、tiny Run cap→budget_exceeded、并发／跨 replica 预留与实际清理。组件／fixture 不替代系统验收；Span/Trace 仅诊断。#52 保持开放，未合并 PR、不轮询 CI、不启动集成；待用户通知 CI 后修复／核对，再推进集成批次。
- **#374 PostgreSQL 组件修复（2026-10-29）**：精确候选 `4be33db8` 的组件门失败为业务失败、cleanup 通过；远程产物未保留断言 stdout。获用户许可后，使用仓库固定 `postgres:17.11-bookworm` 隔离本地数据库、真实 integration overlay 复现 `insertModelCallPolicySyncRow` 的 `SQLSTATE 42P08`：同一 `$3` 在 BIGINT 列与 `CASE` 整数比较中发生类型推断冲突，多项用例在准备阶段失败。现显式标注 `$3::bigint`，并新增零 ACK、正 ACK、超过 32 位范围的 BIGINT fixture 回归；不修改生产策略逻辑或放松断言。Controller 模型策略相关 PG 用例已在真实数据库上全部通过（含 `-race`、无跳过），红／绿原始日志临时保留于 `artifacts/verification/pr-374-pg-4be33db8/local/`；不将其描述为完整服务 CI 或跨服务 Docker E2E。本提交用于 #374 并同步下游 Console；新候选远程 CI 待用户通知，不等待／轮询。
- **CI 交付模型（#361）**：用户于 2026-10-28 收敛目标：①PR 只跑受影响服务；②合并 main 后跑全量 E2E，新合并取消旧 system run；③main 全量 E2E 通过即具备发布能力，CI 不自动打 tag／建 release；④压力测试只在每晚运行；⑤废止 Tier A/B/C 说法。测试镜像不进入 GHCR（旧包由用户处理）。已合并（2026-10-29，均核对精确 head 的远程 Repository／Integration checks 后合入）：第 1 批 #362（`57e2ee30`）PR 门禁仅 component；第 2 批 #378（`06f7dfb`，head `81b0172`）main 只发布 10 个 release 镜像、temporal 与 Runtime 测试变体在每个 run 内从同一 revision 构建并经 artifact 传递、main push 取消被取代的 system run、全量通过记 `release_eligible=true`；第 3 批 #379（`d7b6b02`，head `c5e6b43`）suite `kind` 分为 component／system／stress，readiness 拆为 main 3 轮与 nightly 100 轮 `stress-agent-readiness`，nightly 只跑 stress，main 版本集覆盖全部镜像；第 4 批 #380（`c8ae87a`，head `afdbecf`）Makefile 按 target 选择 suite、不再选中 service 单测。第 5 批 #382（`fb8f522`，head `a13ee04`）：跟踪 issue 每类只保留最新状态（失败改写正文并重开、全量通过关闭、被取消的 run 不触碰），只改 `e2e.yml` 不再选中 PR component suite 与 service 单测。门禁耗时：常规多服务 PR 约 12 分钟（瓶颈为 Repository checks）；改选择器本身会选中全部 9 个 component suite，#378／#379 为 14m32s／15m20s，Identity PostgreSQL 为最长项。验收证据（main 首次新流程全量 E2E、首次 nightly stress、首次 `release_eligible=true`）由用户后续跟踪，发现问题再通知；是否关闭 #361 视跟踪结论。#377 的 Skill 学习失败、#355 Identity PG 720s 退出不属于 #361，另行处理。
- **新发现问题（已挂 Epic，暂不展开）**：#356 ACP v2-inflight 恢复断言 → #82；#252 egress 停止 metrics 报错 → #82；#355 Identity PG 720s 超时、#357 lifecycle restore 退出码 1 → #83。#247 已标 `diagnostic-only`，保持开放。#165–#169、#246 归入 #83 第 5 组（CI 与验证基础设施）。
- **Epic 概况**：#80、#81 已关闭；#82 8/21；#83 6/30（含新挂入 10 项）；#84 0/8；#85 0/5。
- **本地遗留清理（2026-10-28）**：其余 worktree 分支经核对均已由后续 PR 合入或被取代，无未落地改动；仅 `ce87707d` 为真正未交付工作，已 rebase 到 `57e2ee30`。102 个已存在 worktree 目录已移除（记录于 `artifacts/verification/issue-triage-20261028/worktree-preservation/removed-worktrees.json`），15 个 `/private/tmp` 陈旧注册已 prune，所有分支引用保留。`git stash@{0}` 在与 `artifacts/verification/issue-triage-20261028/TODO.working-before-sync.md` 字节一致核对后已 drop。3 个一次性诊断 probe（原未跟踪、按 checkpoint 约定不入库）在 `artifacts/verification/issue-triage-20261028/probes/`。旧＋本轮 run 证据已全部删除（含 `controller-model-policy-20261028/` 临时日志），`artifacts/verification/` 仅保留 issue-triage 下的唯一源码／工作变更备份——原始 TODO/issue JSON/probes、removal 清单、ui-vite-security-patch 工作副本备份与 `unique-working-patches/`（71 个 patch/diff）。配套文档 PR #367 仅处理文档与保留规则。
- **`46b4b078` Controller 批次验证**：批次已含生产方 held-ACK 发布测试（`TestModelCallPolicyMigrationPublicationWaitsForActualHTTPAcknowledgement`：真实 PostgreSQL＋ExecutionPublisher＋实际 acpclient HTTP，ACK 对端为 httptest fixture HTTP peer、非真实 ACP 服务，覆盖 valid_ack／http_failure／old_revision_ack）与共享契约校验。本地验证：domain／application／server 三包 `-run 'Policy'` 全部通过、`acp-model-policy-contract.test.mjs` 6/6 通过；PG 测试本地因缺少数据库全部跳过（非通过证据）。远程组件 CI（[run 40687846518](https://github.com/tf4fun/antnest-platform/actions/runs/40687846518)，evidence-a-agent-controller-postgres）以独立隔离 PostgreSQL 实测：business＋cleanup 均通过，ACK 对端仍为 fixture HTTP peer、非真实 ACP／Docker。PR #366 已合并（squash `852a5215`），整体业务工作流（Provider 观测 → 组织预算 → Console → Docker 业务验收）未交付，#52 保持开放。

## 推进队列

以下每个阶段均拆为单个服务或共享测试工具的交付批次。#67、#68、#48 先交付公共定义与工具，服务迁移随后逐批完成；#112 从第一阶段持续推进。

### 1 回归基线与CI准入

- [x] [#109](https://github.com/tf4fun/antnest-platform/issues/109) test(e2e): consolidate ACP/managed-MCP Compose overlays and stop fixed diagnostic port binds
- [x] [#215](https://github.com/tf4fun/antnest-platform/issues/215) rpc-response-loss: delete lifecycle trace intermittently misses the Admin Console parent span
- [x] [#193](https://github.com/tf4fun/antnest-platform/issues/193) skill-discovery-caller: source Agent projection is intermittently not active and acknowledged after propagation
- [x] [#197](https://github.com/tf4fun/antnest-platform/issues/197) skill-source-lifecycle: Skill source preview intermittently returns 503 during promote
- [x] [#112](https://github.com/tf4fun/antnest-platform/issues/112) ci: run component, browser and Docker E2E suites in GitHub Actions
- [x] [#235](https://github.com/tf4fun/antnest-platform/issues/235) test(lifecycle): replay history assertion races independent Runtime observations（#112 前置批次）
- [x] [#233](https://github.com/tf4fun/antnest-platform/issues/233) test(runtime-egress): scoped privilege logging intermittently captures no event during image builds
- [ ] [#247](https://github.com/tf4fun/antnest-platform/issues/247) Skill discovery trace collection admits traces with missing Gateway parent spans
- [ ] [#361](https://github.com/tf4fun/antnest-platform/issues/361) CI: PR runs component CI only; main is the system integration branch that triggers E2E — #362、#378、#379、#380、#382 已合并；验收证据由用户跟踪，是否关闭待结论
- [x] [#355](https://github.com/tf4fun/antnest-platform/issues/355) Identity PostgreSQL verification exits after ~720s without an actionable failure record — 已关闭（2026-10-29）：根因为 720s 预算耗尽（非挂死），主要成本是 fixture 在 `-race` 下逐个使用生产 Argon2。#384（`cf9eac9`）改用廉价 fixture 策略；#386（`fccb18f`）超时输出原因／阶段／在途测试身份、写入 `go-progress-*.json` 耗时记录，并将 CI Go 缓存对齐到仓库 `.cache`。Identity Go 命令 359.7s → 278.3s（历史 520–716s），720s 预算与业务断言未改
- [ ] [#357](https://github.com/tf4fun/antnest-platform/issues/357) Lifecycle restore verification exits 1 without an independent cleanup result

### 2 共享契约与依赖清单

- [ ] [#67](https://github.com/tf4fun/antnest-platform/issues/67) Error responses use at least four envelope shapes and overlapping code vocabularies across services
- [ ] [#68](https://github.com/tf4fun/antnest-platform/issues/68) Contract conventions drift: pagination, idempotency and optimistic-concurrency fields have several names; schema dialect and $id bases are mixed
- [ ] [#16](https://github.com/tf4fun/antnest-platform/issues/16) contracts: Agent, Organization and User ID grammars differ across services and contradict the opaque-ID rule
- [ ] [#48](https://github.com/tf4fun/antnest-platform/issues/48) Contract tests validate hand-written literals, not real output; no schema_version or N-1 compatibility, so services must deploy in lockstep
- [ ] [#73](https://github.com/tf4fun/antnest-platform/issues/73) P2: docs/service-layout.md dependency graph omits seven live service edges, including an ACP ↔ Skill Registry cycle

### 3 Edge入口安全与旧入口收敛

- [x] [#57](https://github.com/tf4fun/antnest-platform/issues/57) Edge Gateway has no supported HTTPS deployment: no TLS listener and no trusted-proxy model for Origin, cookies and login rate limits
- [x] [#63](https://github.com/tf4fun/antnest-platform/issues/63) Edge Gateway strips a fixed list of identity headers instead of all X-Antnest-*; the list already misses headers that services read
- [x] [#10](https://github.com/tf4fun/antnest-platform/issues/10) Edge Gateway accepts state-changing requests without Origin, and admin and session routes have no Origin check
- [x] [#62](https://github.com/tf4fun/antnest-platform/issues/62) Browser session hardening: cookies lack the __Host- prefix, CSRF token is not bound to the session, Admin and Agent workspace share one origin
- [x] [#2](https://github.com/tf4fun/antnest-platform/issues/2) Login admission allows unauthenticated lockout: OIDC start shares one per-organization counter, and full key tables refuse all new logins
- [x] [#64](https://github.com/tf4fun/antnest-platform/issues/64) Edge Gateway keeps a second browser workspace stack that no shipped UI uses; its ACP relay shares 4 message slots across all users

### 4 Identity安全与管理接口

- [x] [#61](https://github.com/tf4fun/antnest-platform/issues/61) OIDC first login auto-binds any Membership with a matching email, including organization administrators, trusting every Provider's email claim
- [x] [#60](https://github.com/tf4fun/antnest-platform/issues/60) Password verification: no limit inside Identity, unbounded concurrent Argon2 work, and hash parameters that can never change
- [x] [#58](https://github.com/tf4fun/antnest-platform/issues/58) Browser sessions: fixed 12h tokens with no idle timeout or rotation, password change keeps other sessions, no sign-out-everywhere, admin streams revalidated only every 5 minutes
- [x] [#59](https://github.com/tf4fun/antnest-platform/issues/59) Identity is a synchronous dependency of every request and every ACP message, with no resolve cache
- [x] [#66](https://github.com/tf4fun/antnest-platform/issues/66) SCIM tokens never expire, survive the issuing administrator's removal, and SCIM writes have no client-visible version (ETag unsupported)
- [ ] [#65](https://github.com/tf4fun/antnest-platform/issues/65) Admin Console contract: 56 of 59 routes have no request or response schema, no error-code list, and the directory route returns every member unpaginated

### 5 Runtime平面正确性

- [ ] [#38](https://github.com/tf4fun/antnest-platform/issues/38) Runtime-plane contracts are incomplete: Egress lacks request/response schemas, Runtime omits maintenance routes, RC contract lives outside contracts/
- [ ] [#165](https://github.com/tf4fun/antnest-platform/issues/165) test(runtime-controller): cover Skill volume ready, drift and mount faults as component tests
- [ ] [#246](https://github.com/tf4fun/antnest-platform/issues/246) Runtime Controller helper removal and Skill test cleanup can leave anonymous Docker volumes
- [ ] [#168](https://github.com/tf4fun/antnest-platform/issues/168) test(runtime): move packet-path egress and health probe checks out of the platform lifecycle suites
- [x] [#33](https://github.com/tf4fun/antnest-platform/issues/33) Runtime observation journal can permanently skip facts: BIGSERIAL order is not commit order
- [x] [#39](https://github.com/tf4fun/antnest-platform/issues/39) RC observation journal: prune runs inside every append transaction, retention docs disagree, and leader writes are not fenced
- [ ] [#35](https://github.com/tf4fun/antnest-platform/issues/35) Harden Runtime containers: stop grace shorter than shutdown budget, no CPU or disk limits, exec /tmp, writable rootfs
- [ ] [#15](https://github.com/tf4fun/antnest-platform/issues/15) runtime-egress: out-of-range revisions return retryable 503 and path rejections are inconsistent
- [ ] [#6](https://github.com/tf4fun/antnest-platform/issues/6) Runtime internal Skill maintenance tool error codes are not filtered from MCP results, and mcp-contract.md overstates the closed tool_errors list
- [ ] [#18](https://github.com/tf4fun/antnest-platform/issues/18) contracts: shared maintenance ticket schema omits the temporary_install and temporary_release actions

### 6 Controller发布与生命周期

- [ ] [#47](https://github.com/tf4fun/antnest-platform/issues/47) Agent Controller contract hygiene: routes outside the catalog, an orphan RPC, a retired doc, and schema/handler mismatches
- [ ] [#166](https://github.com/tf4fun/antnest-platform/issues/166) test(agent-controller): cover fenced Skill invalidation and interrupted Runtime Update receipts as component tests
- [ ] [#43](https://github.com/tf4fun/antnest-platform/issues/43) Execution snapshot: full per-org payload with decrypted credentials on every mutation and every 30s; publication gate is in-process only
- [x] [#53](https://github.com/tf4fun/antnest-platform/issues/53) ACP maps every DomainError to JSON-RPC -32020 with retryable:false; clients cannot tell busy or not-ready from denied #308合并c1493ec0，原始5/5验收完成并关闭。
- [x] [#44](https://github.com/tf4fun/antnest-platform/issues/44) agent_ready is emitted before ACP has the binding; not-yet-published Agents fail with access_denied instead of a typed pending state 已由PR311合并02e7305f并关闭，原始5/5及100轮真实验收完成。
- [ ] [#45](https://github.com/tf4fun/antnest-platform/issues/45) Agent lifecycle workflows: unbounded retries, no versioning, quarantine has no repair path, failed creates are never collected

### 7 ACP恢复、所有权与保留策略

- [ ] [#167](https://github.com/tf4fun/antnest-platform/issues/167) test(agent-acp-service): cover Skill learning admission rules and persistence faults as component tests — Persistence 组件替代、五项 PG 代理检查及旧平台入口退役已完成本地准入；其余 Skill 学习组件迁移待完成，issue 保持开放。
- [ ] [#71](https://github.com/tf4fun/antnest-platform/issues/71) P2: Give skill learning its own bounded context inside Agent ACP Service (modules, persistence, worker ownership)
- [x] [#50](https://github.com/tf4fun/antnest-platform/issues/50) ACP failure handling has a platform-wide blast radius: one persistence error restarts the process, cold start waits for resync, and a crash mid-tool needs a manual Rebuild #309合并6ef8474e，原始5/5验收完成并关闭。
- [x] [#49](https://github.com/tf4fun/antnest-platform/issues/49) Agent ACP Service can run only one instance: database-wide worker lock, in-memory Run slots and per-org serialization
- [ ] [#356](https://github.com/tf4fun/antnest-platform/issues/356) ACP automatic recovery: localize v2-inflight business assertion failure
- [ ] [#19](https://github.com/tf4fun/antnest-platform/issues/19) agent-acp-service: intent receipt lookup has no intent_receipt_expired outcome required by the Bridge contract
- [ ] [#55](https://github.com/tf4fun/antnest-platform/issues/55) Agent ACP Service persistence: 15 of 23 tables are undocumented, and deleted Sessions keep all content with no retention policy

### 8 ACP协议与连接活性

- [ ] [#56](https://github.com/tf4fun/antnest-platform/issues/56) Production paths depend on experimental ACP SDK surfaces pinned separately in two packages, with no upgrade gate
- [ ] [#54](https://github.com/tf4fun/antnest-platform/issues/54) Real-time path liveness: no WebSocket ping/pong in ACP or Gateway relay; permission approvals wait on possibly-dead connections; Agent UI bridge state is single-instance
- [ ] 待独立复现与登记：Agent UI 在所有浏览器离开、最后 execution 仍 active 时，CCT 到期会阻止终态查询，`activeRunWork` 可持续占用 owner。#58 的只读审计确认现有释放路径缺少年龄上限；先补真实 CCT 过期反例，再定义有界本地退休，不能延长旧凭据或取消已接受 Run。与 #54 生命周期工作相关，尚未计入任何 issue 的交付；详见私有 `issue-58/agent-ui-headless-retention-review.json`。

### 9 模型目录、预算与上下文

- [ ] [#72](https://github.com/tf4fun/antnest-platform/issues/72) P2: Move domain defaults, the built-in model catalog and pricing out of Admin Console into Agent Controller
- [ ] [#46](https://github.com/tf4fun/antnest-platform/issues/46) Agents pin Template revisions but follow live Model Profiles and Provider connections; the mixed semantics are undocumented to users
- [ ] [#52](https://github.com/tf4fun/antnest-platform/issues/52) Model calls have no retry or failover on 429/5xx, and normal Runs have no token or cost budget
- [ ] [#51](https://github.com/tf4fun/antnest-platform/issues/51) Context management: length/4 token estimate is wrong for CJK and images; compaction is mechanical truncation, not summarization
- [ ] [#23](https://github.com/tf4fun/antnest-platform/issues/23) Support generic OpenAI-compatible model providers (openai_compatible is half-wired)

### 10 网络策略与Runtime扩展边界

- [ ] [#40](https://github.com/tf4fun/antnest-platform/issues/40) Egress policy model is allow-all/deny-all only; planned enterprise-internal destinations conflict with the private-address baseline
- [ ] [#74](https://github.com/tf4fun/antnest-platform/issues/74) P2: Kubernetes adapter readiness: Docker types leak through the Runtime Controller platform port, and Runtime requirements (TUN, NET_ADMIN, management network, Skill volumes) have no platform-neutral model
- [ ] [#41](https://github.com/tf4fun/antnest-platform/issues/41) Runtime plane is single-node: /24 management subnet, single Egress instance, Docker resource names not scoped by controller

### 11 Skill产品闭环

- [ ] [#24](https://github.com/tf4fun/antnest-platform/issues/24) i18n: Skill learning notices and change summaries are hard-coded in Chinese
- [ ] [#20](https://github.com/tf4fun/antnest-platform/issues/20) agent-acp-service: draft ACP v2 endpoint has no Skill commands or Skill learning notices
- [ ] [#21](https://github.com/tf4fun/antnest-platform/issues/21) skill-learning: implement the manual "Save as Skill" path (apply_basis=user_action)
- [ ] [#169](https://github.com/tf4fun/antnest-platform/issues/169) test(skill-learning): re-admit UI outage and diagnostics browser journeys once the learning UI settles

### 12 观测、工具及命名收口

- [ ] [#69](https://github.com/tf4fun/antnest-platform/issues/69) Observability: 228 span/metric attribute names with no registry and conflicting synonyms; six diverged copies of the Go telemetry package
- [ ] [#252](https://github.com/tf4fun/antnest-platform/issues/252) runtime-egress: normal Compose stop reports metrics shutdown failure despite successful process exit
- [ ] [#70](https://github.com/tf4fun/antnest-platform/issues/70) Test and dev hygiene: root tests depend on service node_modules and dist internals; the production-shaped Compose override still publishes PostgreSQL, Temporal and Jaeger
- [ ] [#22](https://github.com/tf4fun/antnest-platform/issues/22) Replace internal milestone names (stage1-4, L0, Proposed) in Make targets, Compose profiles, test and doc files, and schema titles

### 13 非交互执行与调度

- [ ] [#77](https://github.com/tf4fun/antnest-platform/issues/77) P3 prerequisite: Identity has no service principals, no delegation, and no binding of external channel accounts to platform users
- [ ] [#78](https://github.com/tf4fun/antnest-platform/issues/78) P3 prerequisite: Agent Controller has no cross-organization event feed and no way for dependent services to register against an Agent before it is deleted
- [ ] [#75](https://github.com/tf4fun/antnest-platform/issues/75) P3 prerequisite: Agent ACP Service has no service-to-service intake API; only an interactive ACP client bound to a human principal can start a Run
- [ ] [#76](https://github.com/tf4fun/antnest-platform/issues/76) P3 prerequisite: one Run per Agent with immediate agent_busy rejection, and approvals that wait up to 30 minutes for a human; define queueing and an unattended execution mode
- [ ] [#79](https://github.com/tf4fun/antnest-platform/issues/79) P3 design: Task Scheduler on Temporal Schedules (time rules, execution identity, Session reuse, overlap, missed fires, recovery)

## 必须保持的依赖

- #57 → #10/#62/#2：外部地址与可信代理先于 Origin、Cookie 和客户端限流。
- #58 → #59：会话撤销和失效边界先于身份缓存。
- #43/#53 → #44 → #45/#50 → #49：发布、就绪、恢复语义先于多副本。
- #19 → #55：先区分回执未知和已过期，再清理历史数据；清理 worker 使用 #49 的所有权规则。
- #73 → #71：明确服务依赖后收敛学习模块；#167 为后续重构提供组件证据。
- #72 → #46/#52 → #51/#23：目录和定价归属先于预算及后续模型能力；摘要与重试计入预算。
- #64 → #54：先决定旧 Gateway relay 的去留，再完善存续连接的活性。
- #35/#74 → #41 的平台扩展部分：先明确资源和平台接口。#74 本身不等同于完成 Kubernetes 部署。
- #24/#71 → #169：学习 UI 语义和文案稳定后完成浏览器验收。
- #49/#52/#53 与 #77/#78 → #75/#76 → #79：持久所有权、预算、错误分类、委托身份和生命周期事件先于无人执行与调度。

## 基线校正与范围说明

- #80 已关闭；#219 等已关闭问题保留回归覆盖，不重新实现。
- #83 正文中 #38、#47、#48 曾被勾选但 issue 仍开放；2026-10-28 按 admission 核对均未完成（`services/runtime-controller/api/` 仍在、`contracts/agent-controller/run-api.md` 仍在、execution snapshot 无 `schema_version`），已取消勾选。#53 已关闭。#81 的 #57、#10、#62、#63、#58、#61、#59、#60、#2、#66 已实际交付，HTTPS、会话撤销与身份缓存条件完成；#64 已由 PR #262 合并交付；加上既有 #1，12 个子项均已关闭，三项退出条件复核通过，#81 已关闭。
- #193 利用 PR #194 的后续失败诊断确认 ACK 延迟，并由 PR #227 修复。#197 在 PR #198 诊断后未再出现同类 CI 失败；本批以真实 gate 固定健康读取竞争并修复，历史单次 503 的归因限制保留在验收记录中。
- #112 曾把 Tier C 纳入 `Integration checks`；#361 第 1 批（#362）之后原 Tier B/C 改在 main 的独立 system-e2e 工作流运行；第 3 批起 Tier 说法废止，suite 只分 `component`（PR）／`system`（main）／`stress`（nightly）三类，`a-`/`b-`/`c-` 仅为历史 id 前缀。`Integration checks` 只含受影响服务的 unit／contract／component。#165–#168 仍随服务补齐替代组件测试（PR 门禁只剩组件层，其价值更高），#169 随 UI 收口。移出 CI 或门禁完成均不代表这些替代测试已交付。
- #18 的旧八动作设计已过时，当前 signer 为 `install`、`digest`、`temporary_install`、`temporary_release`，契约应与当前行为一致。
- #167 以 2026-10-08 的更新为准：前台 Run 不取消 review；Runtime install 等待空闲窗口并可被前台抢占。旧 cleanup release 场景已删除，不恢复它。
- #168 的旧网络失败假设需结合 PR #217 的后续证据重新核对；#70 的端口说明也需按当前 Compose 重定范围。
- #64 已按 Option A 交付并合并：移除旧 bootstrap、state/watch 和直连 ACP relay，浏览器使用 Agent UI Bridge；其余消费方使用经 Identity 授权的私有 ACP 路径。
- #79 虽然标题含 design，验收还包括 Scheduler 的 component 与 Docker E2E 行为。

## Epic 收口

- [x] [#80](https://github.com/tf4fun/antnest-platform/issues/80) P0 服务信任与秘密。已完成；后续批次保持安全回归。
- [x] [#81](https://github.com/tf4fun/antnest-platform/issues/81) 12／12 个子项均已完成；HTTPS 浏览器工作流、HTTP／流会话撤销时限和 Identity 停机缓存降级三项退出条件已用最终 CI 原件复核，2026-10-20 关闭为 completed。
- [ ] [#82](https://github.com/tf4fun/antnest-platform/issues/82) 瞬态故障不丢事实；双 ACP 副本恢复通过 E2E；资源、预算和重试有明确上限。
- [ ] [#83](https://github.com/tf4fun/antnest-platform/issues/83) 所有服务采用共同契约；真实生产/消费响应、N-1 兼容和 router parity 纳入 CI。
- [ ] [#84](https://github.com/tf4fun/antnest-platform/issues/84) 服务依赖准确，领域默认值归属 Controller，平台接口中立，产品子项验收完成。
- [ ] [#85](https://github.com/tf4fun/antnest-platform/issues/85) 委托、接入、排队、无人审批、删除依赖和 Scheduler 集成完成。
- [ ] 补齐 #85 的 Channel Manager 设计与契约交付项；#79 仅覆盖 Task Scheduler。

## 交付记录

以下记录描述交付当时的验证情况；历史“已归档／保留”不代表文件仍在。旧验收日志、截图与 CI 下载产物现已按临时证据策略删除，保留交付结论、远程链接及独有源码备份。

| 日期       | Issue      | PR 或 commit                                                                          | 验证与结果                                                                                                                                                                                                                                                                                                            |
| ---------- | ---------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-10 | 全局队列   | 基线 `814d5041`                                                                       | 65 个开放执行项已分配，未遗漏、未重复；#109 开始调查                                                                                                                                                                                                                                                                  |
| 2026-10-10 | #109       | [PR #223](https://github.com/tf4fun/antnest-platform/pull/223)、`70140fc1`            | 22 个 Compose 场景等价；端口反向回归、仓库/部署检查、45 个 managed fixture 通过；保留开发栈时 ACP v1/v2 WebSocket、v1 HTTP 通过，Stage3a managed MCP 业务/拓扑/删除/清理通过；独立 review 与必需 CI 通过后合并                                                                                                        |
| 2026-10-10 | #215       | [PR #225](https://github.com/tf4fun/antnest-platform/pull/225)、`88453a80`            | 同步父 span 闭合后再判定稳定；迟到、永久缺失和中止回归通过；69 个相关 fixture、完整仓库准入、RPC 默认/延迟导出及 managed MCP ACP v1/v2 Docker 验收、独立 review、必需 CI 和 RPC CI 分片通过后合并                                                                                                                     |
| 2026-10-10 | #193       | [PR #227](https://github.com/tf4fun/antnest-platform/pull/227)、`45752015`            | 确认 active source 2/1 与 peer 1/1 的 ACK 时序缺口；37 个相关测试、完整仓库检查、Docker caller 及清理、独立 review、必需 CI 和 Skill discovery CI 分片通过后合并                                                                                                                                                      |
| 2026-10-10 | #197       | [PR #231](https://github.com/tf4fun/antnest-platform/pull/231)、`e8cf8f15`            | 确定性读取竞争先 red 后 green；1,706 个 ACP 单元测试、202 个集成测试、完整仓库检查、Docker source lifecycle 及清理、独立 review、必需 CI 和 discovery/learning/install-lifecycle 分片通过后合并；历史单次 503 缺少 trace，未回溯归因                                                                                  |
| 2026-10-10 | #112、#235 | [PR #234](https://github.com/tf4fun/antnest-platform/pull/234)、`dec230dc`            | Tier C 成为必需门禁，新增三个已有 Docker 入口，完整终态与逐套件证据校验；独立修复 lifecycle 重放/观察竞争。2,307 Node、61 Python、适用 Docker 与清理、独立 review、全部 81 个 CI 套件与 47 项 PR 检查通过；部分手动运行不能提供完整必需检查                                                                           |
| 2026-10-11 | #63        | [PR #245](https://github.com/tf4fun/antnest-platform/pull/245)、`c40b6b47`            | 28 契约、20 消费方、Gateway race 173/1,064、真实 HTTPS 48 个伪造 Header、15 readiness 反例与完整 Docker caller 通过；52 PR 检查、82 套件/21 分片准入。扩展证据缺口独立登记 #246/#247，下一项 #58。                                                                                                                    |
| 2026-10-11 | #58        | [PR #249](https://github.com/tf4fun/antnest-platform/pull/249)、`8f854c76`            | 双期限、事务轮换/撤销、静默流退役、双浏览器会话控制与真实 HTTPS 通过；58 PR 检查、83 套件/21 分片准入，保留原始严格告警与 #246/#247 证据限制。下一项 #61。                                                                                                                                                            |
| 2026-10-11 | #61        | [PR #251](https://github.com/tf4fun/antnest-platform/pull/251)、`af0ac319`            | OIDC 显式策略、预绑定/SCIM 配对、双浏览器 notice/解绑与真实 HTTPS 已交付；56 项 PR 检查、83 套件/21 分片准入，1,330 个最终 CI 文件已校验归档。保留 #246/#247 限制，新登记 #252。下一项 #59。                                                                                                                          |
| 2026-10-13 | #59        | [PR #254](https://github.com/tf4fun/antnest-platform/pull/254)、`1fcf37ab`            | 完整 Principal 缓存、撤销/活动边界与 Identity 停机降级交付；61 项 PR 检查、84 套件/21 分片准入，4,419 Node/61 Python 通过，最终 CI 1,686 个文件校验归档。原始失败、Node SDK 延后调查及 #246/#247 限制保留。下一项 #60。                                                                                               |
| 2026-10-13 | #60        | [PR #256](https://github.com/tf4fun/antnest-platform/pull/256)、`85f6a65f`            | 密码资源预算、持久失败计数、rehash/原子轮换、规范 429/503 及双实例 HTTPS 验收完成；56 项 PR 检查、84 套件/21 分片，72 passed/12 已复核 warning，零失败。保留原始严格诊断、历史归因与 #246/#247/#252 限制。下一项 #2。                                                                                                 |
| 2026-10-13 | #2         | [PR #258](https://github.com/tf4fun/antnest-platform/pull/258)、`f702676c`            | 三表独立限流、IPv6 /64 与有界 FIFO 淘汰交付；双实际来源签名 SSO、35 条零告警 Trace 通过。53 项成功 PR 检查、84 套件/21 分片准入，1,775 个原始文件已校验归档；原始诊断与 #246/#247/#252 限制保留。下一项 #66。                                                                                                         |
| 2026-10-14 | #66        | [PR #260](https://github.com/tf4fun/antnest-platform/pull/260)、`5214a8bb`            | SCIM 到期/签发者联动、独立轮换与 ETag 条件写交付；55 项 PR 检查、84 套件/21 分片准入，72 passed/12 已复核 warning，零失败。真实 HTTPS 51 次响应、15 次拒绝无写入，2,017 个最终 CI/准入文件已校验归档；历史失败、raw strict 与 #246/#247/#252 边界保留。下一项 #64。                                                   |
| 2026-10-20 | #64        | [PR #262](https://github.com/tf4fun/antnest-platform/pull/262)、`2bfdf4a5`            | Option A 旧入口退役及消费方迁移、内部服务修复完成；最终 c2c6ab83 的 66 项检查／14 个 workflow、85 套／21 分片全部准入（67 passed／18 已接受 warning），适用 Workspace／Development 真部署与独立审查通过。用户授权后 squash 合并，合并树与验收候选一致，#64 自动关闭；原始诊断、失败历史及匿名卷测试替身清理待办保留。 |
| 2026-10-20 | #81 Epic   | [#81 收口](https://github.com/tf4fun/antnest-platform/issues/81)、验收基线 `2bfdf4a5` | 12 个子 issue 全部 completed，结构化清单与正文一致，无阻塞依赖；HTTPS、会话撤销、Identity 故障缓存降级三项退出条件均由最终 CI 原件复核通过，已记录依据并关闭 Epic。独立匿名卷清理待办与原始诊断保留。                                                                                                                 |
| 2026-10-28 | #52        | [PR #366](https://github.com/tf4fun/antnest-platform/pull/366)、`852a5215`            | Controller 模型调用策略生产方交付，`46b4b078` 合入未变；远程组件 run 40687846518 隔离 PostgreSQL business＋cleanup 通过（ACK 为 fixture peer）；#52 开放，Provider／预算／Console／系统 E2E 未验收。                                                                                                                  |
