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

- **#51 上下文管理（2026-10-29）**：按 Controller → ACP → Admin Console → 独立集成批次交付，每个服务独立 PR，不等待 CI、不自动合并或关闭父 issue。Controller 批次已定义可选 `tokenizer`（`o200k`／`cl100k`／`none`）与 `compaction_model_profile_id`，通过现有模型 JSON 持久化及 execution snapshot 透传；domain／application 定向测试已先红（unknown field）后绿。ACP 估算、校准、模型摘要、首任务 pinning、溢出重试，Console 配置和系统验收均待交付；远程完整门禁待 PR CI，不以定向本地结果代替。
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
