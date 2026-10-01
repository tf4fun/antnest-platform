# Skill 动态发现：ACP D4A 临时文件交付与回收

日期：2026-10-01。本批只实现 Agent ACP Service 消费者，承接
[Runtime D4](skill-discovery-runtime-delivery-20261001.md)和
[D3 模型工具](skill-discovery-tools-delivery-20261001.md)。所属服务门禁与隔离
Docker 业务回归已通过；用户提升界面和完整四步 DI1 尚未交付。

## 已交付行为

- 按[消费者合同](../contracts/agent-acp/skill-temporary-consumer.md)先写测试，再实现。
  `find_skill` 仍是只读搜索；`load_skill` 使用普通文件操作审批，先核对固定来源
  与摘要，再把多文件 ZIP 交给 Runtime。只有严格核验已安装回执后才返回路径。
  文本包继续返回 `temporary_files=null`，不保留无用 ZIP。
- 安装前从活动 Run、Session 和冻结 Runtime 派生并持久登记清理范围。模型不能
  指定身份、URL 或写入位置。包只存在于有界请求内存，不成为 ACP 缓存，更不
  复制进 Registry 的动态投影。失去回复的安装不会自动重发。
- 成功、失败或取消时，在终态持久化及释放 Agent 执行位前尝试回收。回收使用
  worker 所有权信号，不使用已经取消的 Run 信号；未知效果保留待回收记录并
  返回未解决结果，不冒称清理成功。
- 新 Run 准入、学习维护和生命周期结算都检查待回收范围。确认停止只更新
  本 Run 的平台 load 记录，不覆盖普通 Runtime/client 调用或历史未知效果。
- 重启恢复区分纯文本读取和已登记的安装。串行 worker 只处理已结束 Run 的
  待回收记录，通过现有 Agent 执行门排除前景与维护。前景可以取消它；其持久
  围栏与学习未知效果分别管理，不清除无关学习屏障。
- 回收核对 Controller 已发布的当前绑定；没有发布绑定时核对冻结地址。
  原进程须返回准确 release 回执。同 Agent 的新 ready execution 可证明启动
  清理；新发布绑定必须报告准确 execution，旧地址不可用或 404 本身不是证据。
  关闭发现功能不会卸掉回收与准入保护，缺少签名密钥也不会发送未签名修改。
- 网络、正文和等待都有界；外层安装最长 75 秒，回收单次最长 12 秒，只重试
  明确拒绝且未执行的 `runtime_busy`。取消关闭回复读取。Trace 记录 Run、摘要和
  安装/回收结果，不记录包正文、凭据或查询正文。

## 门禁与证据

| 门禁                          | 结果                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| ACP 单元                      | 123 文件、1133 项通过，零跳过                                                                                                             |
| PostgreSQL                    | 37 文件、322 项通过，零跳过；范围身份、漂移拒绝、重启效果及准入保护                                                                       |
| 组件与合同                    | 19 文件、174 项通过；真实 HTTP 签名字节、严格共享回执、取消关闭连接                                                                       |
| Runtime wire 与确定性模型夹具 | 共享 schema 与发现/多文件读/Bash 模型夹具通过                                                                                             |
| 静态检查                      | TypeScript、服务与根测试 lint、服务格式检查通过                                                                                           |
| 隔离 Docker                   | antnest-lifecycle-56332050：真实自动学习/更新与动态投影、双 Agent 正文发现、正式多文件包普通 read/Bash、取消、正常 ACP 重启和后续准入通过 |

多文件包由正常管理员上传，自动学习首版仍只生成 SKILL.md。本批没有借夹具
扩大自动学习包格式；自动投影继续由另一个真实 Agent 的学习结果证明。
三个使用过文件的 Run 均留下关闭范围，检查临时树实际为空，个人与预设目录
没有新增该临时 Skill。来源 Agent 的个人 Skill 仍存在。重启过程使用正常停机，
没有把 SIGKILL 当作稳定测试步骤。

Jaeger 中三个安装 Run 均包含 ACP load/install 和 Runtime install，回收记录
包含准确 Run 的 Runtime released 结果；正常重启后的后台回收具有独立 Trace，
通过 Run 身份关联。六次 Native install/release 都能沿完整父链找到对应 ACP
消费者 span，没有缺失父 span；该核验已保存为可复用的 E2E 断言。正文捕获
关闭，没有引入全局 NTP 验收。

私有证据在 artifacts/verification/skill-discovery-d4a-20261001/；完整学习业务
报告同时保存在 artifacts/verification/skill-learning/antnest-lifecycle-56332050.json。
证据不进入 Git 和 Docker 构建上下文。此前红测试、旧审批/返回值断言、迁移
清单遗漏与首次 Docker 的重复登录 429 都保留；429 通过测试登录复用修正，
没有放宽产品限流。

两个隔离 Docker 项目与候选镜像已清理。资源清单回到验收前的 17 个停机容器、
15 个网络、11 个卷，没有运行中的容器；此前停机环境未被重新启动。

## 后续批次结果

动态来源仍由 Agent 管内容与生命周期，正式提升才由 Registry 托管完整包。
[Console D6](skill-discovery-console-delivery-20261001.md) 来源展示/显式提升入口
及 [DI1](skill-propagation-integration-delivery-20261001.md)“自动投影 → 临时使用
→ 用户提升 → 模板/rebuild 预设交付”已分别通过所属及完整集成门禁，必要
Agent UI 工具/学习通知复用现有实现。本批证据保持原有范围，没有修改其他服务
实现或部署旧验收环境。
