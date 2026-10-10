# Antnest Platform 全局 TODO

本清单保存全部开放 issue 的推进顺序、依赖、当前批次和验收记录。
按回归基线、共享契约、入口与身份安全、执行可靠性、产品能力、非交互执行与调度推进。
Issue 状态最后核对于 2026-10-10：133 个 issue，68 个已关闭，65 个开放；开放项包含 5 个 Epic 和 60 个执行项。下列队列保留 67 个执行项，其中 7 个已交付。

## 执行约定

- 协调者选择批次、定义契约和测试、review 所有修改，独占 Git、网络、Docker、浏览器、验证与合并操作。
- 子 agent 使用 `gpt-6.1-sol`、`max` reasoning、独立上下文；任务只传必要的 issue、文件与约束，返回简短交接。
- 子 agent 可以只读调查。写入任务必须只有一个明确且互不重叠的写集合、一个机械变换；不运行测试、构建、生成器、Docker、网络或 Git。
- 每批遵循共享契约、单个服务的测试/实现/文档、消费方批次、显式集成验收的顺序。新行为先有失败测试。
- 协调者串行执行适用的 unit、contract、component、Docker E2E；检查资源清理。通过 review 和必需 CI 后才合并。
- 合并后记录 PR、commit、验证证据并更新复选框。生产方完成但消费方或集成待交付时，issue 保持开放。
- 验证证据保存在忽略的 `artifacts/verification/`；测试源、fixtures 和清单遵循 [AGENTS.md](AGENTS.md)，不存放在 `.cache/`。
- 开始下一项前读取本文件的当前批次、相关阶段和依赖，并重新核对该 issue 的正文、讨论与当前代码。

## 当前批次

- 下一执行项：[#67](https://github.com/tf4fun/antnest-platform/issues/67)，先交付共享错误契约、代码登记表与验证工具，记录各消费方迁移；随后按服务分批交付，最后执行跨服务集成验收。共享定义完成不能代表整项迁移完成。
- 最近完成：#233 已随 [PR #237](https://github.com/tf4fun/antnest-platform/pull/237) 合并并关闭，commit `de419be1`。独立测试先固定无 subscriber 线程注册 callsite 导致事件捕获为 0 的反例；复用测试专用持久 dispatcher 和 provider-drop 预热后，event/span 各精确捕获 1 条，过滤器仍捕获 0 条。14 个构造入口覆盖 16 处 scoped 使用，保留默认并行测试和严格权限断言。
- #233 验收：格式、Clippy、195 个本地 Rust 测试、12 个 PostgreSQL 组件、Linux 镜像内 196 个测试均通过；本地与 CI 的 `auth-egress` 均完成 189 项检查及资源清理。独立 review、仓库门禁、五种 CodeQL 及 [最终集成 CI](https://github.com/tf4fun/antnest-platform/actions/runs/38043501755) 通过；后者用时 31 分 12 秒，覆盖 26 个 job、19 个分片和全部 58 个选中套件（48 个正常退出，10 个保留已审查的严格 trace 告警）。证据在 `artifacts/verification/issue-233/`。
- #233 外部限制：[GitHub AI 安全审查](https://github.com/tf4fun/antnest-platform/actions/runs/38043504349) 因月度额度耗尽（402）在分析前失败。该项不是分支必需检查，失败记录保留；两项分支必需检查 Repository checks、Integration checks 均通过，五种常规 CodeQL 也通过后合并。
- 已完成：#112 与前置 #235 已随 [PR #234](https://github.com/tf4fun/antnest-platform/pull/234) 合并并关闭，commit `dec230dc`。所有选中的 A/B/C 分片纳入必需门禁，部分手动运行使用独立检查名称；严格退出需要真实业务终态，套件日志、结果与耗时均归档。
- 最近插入批次：镜像发布范围已随 [PR #229](https://github.com/tf4fun/antnest-platform/pull/229) 合并，commit `47a80f1c`。仅发布十个已实现的服务/Runtime 镜像；Temporal 依赖和三个 Runtime 测试变体保留本地构建，以同次 CI artifact 传递。
- 镜像批次验收：53 个相关测试、完整 `make test-repo`、格式/语法/链接检查、独立 review、最终提交的必需 CI 和全部 Tier A/B Docker 分片通过。main [run 38026470361](https://github.com/tf4fun/antnest-platform/actions/runs/38026470361) 的四个镜像均构建成功，registry 登录与发布步骤均跳过。
- 已按用户授权删除 `antnest-temporal`、`antnest-runtime-skill-gate`、`antnest-runtime-fixture`、`antnest-runtime-managed` 四个 GHCR package；浏览器确认 [Packages 列表](https://github.com/tf4fun/antnest-platform/packages) 从 14 项降为 10 项，仅保留计划内镜像。验证记录和截图在 `artifacts/verification/ci-package-scope/`；更广泛的 #112 随后由 PR #234 完成。
- #112 准入前稳定性审计覆盖 41 次已完成 CI、319 个实际 Tier C job；最后 12 轮的 132 个 Tier C 分片均成功（其中一轮 Tier B 认证失败），最后 7 次全流程全部通过，约 24–32 分钟。首次必需门禁真实阻止了 #235 的 lifecycle 失败；修复后 [最终 CI](https://github.com/tf4fun/antnest-platform/actions/runs/38040208584) 在 30 分 35 秒内通过全部 27 个 job、21 个分片和 81 个套件，全部 47 项 PR 检查通过后合并。71 个套件正常退出，10 个按已审查的严格 trace 告警规则通过；原始严格结论保留。
- #112 覆盖已有平台加密密钥轮换、Gateway shutdown、Runtime Controller archive Docker 入口。最终 `make test-repo` 通过（2,307 Node 通过、5 个条件跳过，61 Python 通过），69 个 archive 包测试通过 race 检查且无跳过；适用 Docker、清理、静态检查和独立 review 均通过。[部分手动运行](https://github.com/tf4fun/antnest-platform/actions/runs/38036575652) 只产生 `Integration checks (partial)`。证据在 `artifacts/verification/issue-112/`；#165–#169 的 23 项服务测试迁移仍保持开放。
- #112 审计发现的独立回归 [#233](https://github.com/tf4fun/antnest-platform/issues/233) 已按 Runtime Egress 所有权修复。原始权限日志空输出发生在镜像构建阶段，Docker 业务场景尚未启动；确定性反例验证了 tracing callsite 竞争路径，但历史日志仍不能确认当次线程顺序。修复没有引入重试或串行化普通测试。
- #235 已修复失败 Runtime 的独立观察事件与整页重放断言竞争，限定共享 lifecycle 测试工具：保留旧历史前缀，核对持久事件目标、独立观察 trace，以及重放的只读事务。测试先 red 后 green；本地 Docker 验证 9 次操作、3 条观察事件及清理，最终 CI 也验证 9 次操作、2 条观察事件与只读重放。原始失败缺少当次观察 trace，不推断具体观察分支；服务实现未变。
- 已完成：#197 已随 [PR #231](https://github.com/tf4fun/antnest-platform/pull/231) 合并并关闭，commit `e8cf8f15`。已用真实 gate 固定 catalog→artifact、inspect→artifact 两个健康读取竞争反例；ACP 改为只在 source/catalog 读取间限时等待 2 秒，派发前重新校验，前台/lifecycle 取消等待者。
- #197 验收：1,706 个 ACP 单元测试、202 个协议/HTTP 集成测试、完整 `make test-repo`、格式/lint/类型/链接检查、独立 review、修复镜像的完整 Docker lifecycle 流程及清理均通过。最终提交的必需 CI 和 Skill discovery/deployment、Skill learning、Skill learning install/lifecycle 分片在 [run 38031415735](https://github.com/tf4fun/antnest-platform/actions/runs/38031415735) 通过后合并。
- #197 的原始失败缺少同次 trace，不能回溯确认原因。#198 后 67 次 CI 的 50 个实际 discovery 分片中未见 preview 503；当前原版 Docker lifecycle 也通过。本批修复确定性读取竞争，保留 HTTP 200 断言、写入/cleanup/前台忙时的拒绝，不重试 HTTP 或 digest。证据在 `artifacts/verification/issue-197/findings.json`。
- 跨批次精简交接：`artifacts/verification/issue-planning-20261010/next-investigations.json`。开始前重新核对 issue 讨论、当前代码和最近 CI artifact。
- 已完成：#193 已随 [PR #227](https://github.com/tf4fun/antnest-platform/pull/227) 合并并关闭，commit `45752015`。后续失败 run `37731909405` / `37719450273` 证明源投影仍 active、sequence=2、sent_sequence=1，managed candidate/digest 一致，而 peer 已为 1/1；peer ACK 和 live discovery 都不能代表源投影已经确认。
- #193 修复：caller Run 前仅对有效源投影等待 ACK，期限 90 秒；撤销、身份或序号变化、查询失败、取消及超时仍失败，Run 后检查仍立即断言。未修改服务实现。
- #193 验收：37 个相关 fixture/契约测试、完整 `make test-repo`、格式/语法/链接检查、完整 Docker caller 流程和资源清理通过；独立 review、最终提交的必需 CI 和 Skill discovery/deployment CI 分片通过后合并。原始失败、red/green、Docker 与 CI 证据在 `artifacts/verification/issue-193/`。
- #193 合并时尚在运行的非必需 Tier C 分片，后续已在 [CI run](https://github.com/tf4fun/antnest-platform/actions/runs/38023201384) 全部通过。

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

### 2 共享契约与依赖清单

- [ ] [#67](https://github.com/tf4fun/antnest-platform/issues/67) Error responses use at least four envelope shapes and overlapping code vocabularies across services
- [ ] [#68](https://github.com/tf4fun/antnest-platform/issues/68) Contract conventions drift: pagination, idempotency and optimistic-concurrency fields have several names; schema dialect and $id bases are mixed
- [ ] [#16](https://github.com/tf4fun/antnest-platform/issues/16) contracts: Agent, Organization and User ID grammars differ across services and contradict the opaque-ID rule
- [ ] [#48](https://github.com/tf4fun/antnest-platform/issues/48) Contract tests validate hand-written literals, not real output; no schema_version or N-1 compatibility, so services must deploy in lockstep
- [ ] [#73](https://github.com/tf4fun/antnest-platform/issues/73) P2: docs/service-layout.md dependency graph omits seven live service edges, including an ACP ↔ Skill Registry cycle

### 3 Edge入口安全与旧入口收敛

- [ ] [#57](https://github.com/tf4fun/antnest-platform/issues/57) Edge Gateway has no supported HTTPS deployment: no TLS listener and no trusted-proxy model for Origin, cookies and login rate limits
- [ ] [#63](https://github.com/tf4fun/antnest-platform/issues/63) Edge Gateway strips a fixed list of identity headers instead of all X-Antnest-*; the list already misses headers that services read
- [ ] [#10](https://github.com/tf4fun/antnest-platform/issues/10) Edge Gateway accepts state-changing requests without Origin, and admin and session routes have no Origin check
- [ ] [#62](https://github.com/tf4fun/antnest-platform/issues/62) Browser session hardening: cookies lack the __Host- prefix, CSRF token is not bound to the session, Admin and Agent workspace share one origin
- [ ] [#2](https://github.com/tf4fun/antnest-platform/issues/2) Login admission allows unauthenticated lockout: OIDC start shares one per-organization counter, and full key tables refuse all new logins
- [ ] [#64](https://github.com/tf4fun/antnest-platform/issues/64) Edge Gateway keeps a second browser workspace stack that no shipped UI uses; its ACP relay shares 4 message slots across all users

### 4 Identity安全与管理接口

- [ ] [#61](https://github.com/tf4fun/antnest-platform/issues/61) OIDC first login auto-binds any Membership with a matching email, including organization administrators, trusting every Provider's email claim
- [ ] [#60](https://github.com/tf4fun/antnest-platform/issues/60) Password verification: no limit inside Identity, unbounded concurrent Argon2 work, and hash parameters that can never change
- [ ] [#58](https://github.com/tf4fun/antnest-platform/issues/58) Browser sessions: fixed 12h tokens with no idle timeout or rotation, password change keeps other sessions, no sign-out-everywhere, admin streams revalidated only every 5 minutes
- [ ] [#59](https://github.com/tf4fun/antnest-platform/issues/59) Identity is a synchronous dependency of every request and every ACP message, with no resolve cache
- [ ] [#66](https://github.com/tf4fun/antnest-platform/issues/66) SCIM tokens never expire, survive the issuing administrator's removal, and SCIM writes have no client-visible version (ETag unsupported)
- [ ] [#65](https://github.com/tf4fun/antnest-platform/issues/65) Admin Console contract: 56 of 59 routes have no request or response schema, no error-code list, and the directory route returns every member unpaginated

### 5 Runtime平面正确性

- [ ] [#38](https://github.com/tf4fun/antnest-platform/issues/38) Runtime-plane contracts are incomplete: Egress lacks request/response schemas, Runtime omits maintenance routes, RC contract lives outside contracts/
- [ ] [#165](https://github.com/tf4fun/antnest-platform/issues/165) test(runtime-controller): cover Skill volume ready, drift and mount faults as component tests
- [ ] [#168](https://github.com/tf4fun/antnest-platform/issues/168) test(runtime): move packet-path egress and health probe checks out of the platform lifecycle suites
- [ ] [#33](https://github.com/tf4fun/antnest-platform/issues/33) Runtime observation journal can permanently skip facts: BIGSERIAL order is not commit order
- [ ] [#39](https://github.com/tf4fun/antnest-platform/issues/39) RC observation journal: prune runs inside every append transaction, retention docs disagree, and leader writes are not fenced
- [ ] [#35](https://github.com/tf4fun/antnest-platform/issues/35) Harden Runtime containers: stop grace shorter than shutdown budget, no CPU or disk limits, exec /tmp, writable rootfs
- [ ] [#15](https://github.com/tf4fun/antnest-platform/issues/15) runtime-egress: out-of-range revisions return retryable 503 and path rejections are inconsistent
- [ ] [#6](https://github.com/tf4fun/antnest-platform/issues/6) Runtime internal Skill maintenance tool error codes are not filtered from MCP results, and mcp-contract.md overstates the closed tool_errors list
- [ ] [#18](https://github.com/tf4fun/antnest-platform/issues/18) contracts: shared maintenance ticket schema omits the temporary_install and temporary_release actions

### 6 Controller发布与生命周期

- [ ] [#47](https://github.com/tf4fun/antnest-platform/issues/47) Agent Controller contract hygiene: routes outside the catalog, an orphan RPC, a retired doc, and schema/handler mismatches
- [ ] [#166](https://github.com/tf4fun/antnest-platform/issues/166) test(agent-controller): cover fenced Skill invalidation and interrupted Runtime Update receipts as component tests
- [ ] [#43](https://github.com/tf4fun/antnest-platform/issues/43) Execution snapshot: full per-org payload with decrypted credentials on every mutation and every 30s; publication gate is in-process only
- [ ] [#53](https://github.com/tf4fun/antnest-platform/issues/53) ACP maps every DomainError to JSON-RPC -32020 with retryable:false; clients cannot tell busy or not-ready from denied
- [ ] [#44](https://github.com/tf4fun/antnest-platform/issues/44) agent_ready is emitted before ACP has the binding; not-yet-published Agents fail with access_denied instead of a typed pending state
- [ ] [#45](https://github.com/tf4fun/antnest-platform/issues/45) Agent lifecycle workflows: unbounded retries, no versioning, quarantine has no repair path, failed creates are never collected

### 7 ACP恢复、所有权与保留策略

- [ ] [#167](https://github.com/tf4fun/antnest-platform/issues/167) test(agent-acp-service): cover Skill learning admission rules and persistence faults as component tests
- [ ] [#71](https://github.com/tf4fun/antnest-platform/issues/71) P2: Give skill learning its own bounded context inside Agent ACP Service (modules, persistence, worker ownership)
- [ ] [#50](https://github.com/tf4fun/antnest-platform/issues/50) ACP failure handling has a platform-wide blast radius: one persistence error restarts the process, cold start waits for resync, and a crash mid-tool needs a manual Rebuild
- [ ] [#49](https://github.com/tf4fun/antnest-platform/issues/49) Agent ACP Service can run only one instance: database-wide worker lock, in-memory Run slots and per-org serialization
- [ ] [#19](https://github.com/tf4fun/antnest-platform/issues/19) agent-acp-service: intent receipt lookup has no intent_receipt_expired outcome required by the Bridge contract
- [ ] [#55](https://github.com/tf4fun/antnest-platform/issues/55) Agent ACP Service persistence: 15 of 23 tables are undocumented, and deleted Sessions keep all content with no retention policy

### 8 ACP协议与连接活性

- [ ] [#56](https://github.com/tf4fun/antnest-platform/issues/56) Production paths depend on experimental ACP SDK surfaces pinned separately in two packages, with no upgrade gate
- [ ] [#54](https://github.com/tf4fun/antnest-platform/issues/54) Real-time path liveness: no WebSocket ping/pong in ACP or Gateway relay; permission approvals wait on possibly-dead connections; Agent UI bridge state is single-instance

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
- #81/#83 的 #10、#38、#47、#48、#53 已勾选，但 issue 仍开放且存在未交付内容。逐项按 admission 校正 Epic 状态。
- #193 利用 PR #194 的后续失败诊断确认 ACK 延迟，并由 PR #227 修复。#197 在 PR #198 诊断后未再出现同类 CI 失败；本批以真实 gate 固定健康读取竞争并修复，历史单次 503 的归因限制保留在验收记录中。
- #112 已把当前 Tier C 纳入 `Integration checks` 并补齐现有入口和证据；#165–#168 仍随服务补齐替代测试，#169 随 UI 收口。移出 CI 或门禁完成均不代表这些替代测试已交付。
- #18 的旧八动作设计已过时，当前 signer 为 `install`、`digest`、`temporary_install`、`temporary_release`，契约应与当前行为一致。
- #167 以 2026-10-08 的更新为准：前台 Run 不取消 review；Runtime install 等待空闲窗口并可被前台抢占。旧 cleanup release 场景已删除，不恢复它。
- #168 的旧网络失败假设需结合 PR #217 的后续证据重新核对；#70 的端口说明也需按当前 Compose 重定范围。
- #64 先记录移除旧入口或保留外部 ACP 接口的决定，随后只完善保留的路径。
- #79 虽然标题含 design，验收还包括 Scheduler 的 component 与 Docker E2E 行为。

## Epic 收口

- [x] [#80](https://github.com/tf4fun/antnest-platform/issues/80) P0 服务信任与秘密。已完成；后续批次保持安全回归。
- [ ] [#81](https://github.com/tf4fun/antnest-platform/issues/81) HTTPS 浏览器工作流、会话撤销时限与身份缓存失效边界均通过集成验收。
- [ ] [#82](https://github.com/tf4fun/antnest-platform/issues/82) 瞬态故障不丢事实；双 ACP 副本恢复通过 E2E；资源、预算和重试有明确上限。
- [ ] [#83](https://github.com/tf4fun/antnest-platform/issues/83) 所有服务采用共同契约；真实生产/消费响应、N-1 兼容和 router parity 纳入 CI。
- [ ] [#84](https://github.com/tf4fun/antnest-platform/issues/84) 服务依赖准确，领域默认值归属 Controller，平台接口中立，产品子项验收完成。
- [ ] [#85](https://github.com/tf4fun/antnest-platform/issues/85) 委托、接入、排队、无人审批、删除依赖和 Scheduler 集成完成。
- [ ] 补齐 #85 的 Channel Manager 设计与契约交付项；#79 仅覆盖 Task Scheduler。

## 交付记录

| 日期 | Issue | PR 或 commit | 验证与结果 |
| --- | --- | --- | --- |
| 2026-10-10 | 全局队列 | 基线 `814d5041` | 65 个开放执行项已分配，未遗漏、未重复；#109 开始调查 |
| 2026-10-10 | #109 | [PR #223](https://github.com/tf4fun/antnest-platform/pull/223)、`70140fc1` | 22 个 Compose 场景等价；端口反向回归、仓库/部署检查、45 个 managed fixture 通过；保留开发栈时 ACP v1/v2 WebSocket、v1 HTTP 通过，Stage3a managed MCP 业务/拓扑/删除/清理通过；独立 review 与必需 CI 通过后合并 |
| 2026-10-10 | #215 | [PR #225](https://github.com/tf4fun/antnest-platform/pull/225)、`88453a80` | 同步父 span 闭合后再判定稳定；迟到、永久缺失和中止回归通过；69 个相关 fixture、完整仓库准入、RPC 默认/延迟导出及 managed MCP ACP v1/v2 Docker 验收、独立 review、必需 CI 和 RPC CI 分片通过后合并 |
| 2026-10-10 | #193 | [PR #227](https://github.com/tf4fun/antnest-platform/pull/227)、`45752015` | 确认 active source 2/1 与 peer 1/1 的 ACK 时序缺口；37 个相关测试、完整仓库检查、Docker caller 及清理、独立 review、必需 CI 和 Skill discovery CI 分片通过后合并 |
| 2026-10-10 | #197 | [PR #231](https://github.com/tf4fun/antnest-platform/pull/231)、`e8cf8f15` | 确定性读取竞争先 red 后 green；1,706 个 ACP 单元测试、202 个集成测试、完整仓库检查、Docker source lifecycle 及清理、独立 review、必需 CI 和 discovery/learning/install-lifecycle 分片通过后合并；历史单次 503 缺少 trace，未回溯归因 |
| 2026-10-10 | #112、#235 | [PR #234](https://github.com/tf4fun/antnest-platform/pull/234)、`dec230dc` | Tier C 成为必需门禁，新增三个已有 Docker 入口，完整终态与逐套件证据校验；独立修复 lifecycle 重放/观察竞争。2,307 Node、61 Python、适用 Docker 与清理、独立 review、全部 81 个 CI 套件与 47 项 PR 检查通过；部分手动运行不能提供完整必需检查 |
