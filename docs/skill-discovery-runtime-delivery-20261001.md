# Skill 动态发现：Runtime D4 临时文件接口交付

日期：2026-10-01。所属实现是 Antnest Runtime，承接
[D3 模型搜索/正文加载](skill-discovery-tools-delivery-20261001.md)和
[四步传播方案](evolver-technical-analysis.md#112-用户确定的四步产品流程)。
本批完成时只交付 Runtime 生产者，模型工具仍只返回正文。后续
[ACP D4A](skill-discovery-temporary-consumer-delivery-20261001.md) 已独立交付文件
使用、持久回收与恢复并通过门禁；[Console D6](skill-discovery-console-delivery-20261001.md)
及[完整四步 DI1](skill-propagation-integration-delivery-20261001.md) 后续也已通过各自门禁，
真实模型页面演示见[人工验收记录](skill-propagation-human-acceptance-20261001.md)，仍待用户体验确认。

## 行为与边界

- 先登记[私有语义合同](../contracts/runtime/temporary-skills.md)和
  [严格 wire schema](../contracts/runtime/temporary-skills.schema.json)，再补测试和
  实现。install/release 不进入模型 tools/list，普通 tools/call 拒绝保留名称。
- 复用已有维护签名及 current/next 公钥 bootstrap，以独立 action 绑定当前
  Runtime execution、Agent、Run、请求与正文摘要；不新增 RC 配置或软链接。
- 完整 ZIP 校验后，通过私有执行器降权到 UID/GID 1000，在工作区保留命名空间
  写入真实目录和文件。包与旁置回执分别核验，脚本保留执行位并使用既有 0700
  权限，普通 read 和前景 Bash 可使用返回路径。
- 每个 Runtime 同时只有一个临时 Run；最多四个请求身份、四个包和 128 MiB
  解包内容，单包沿用 32 MiB/256 项规则。同请求不同摘要、已交付内容漂移
  明确拒绝，不覆盖；相同内容核验后复用。
- 该临时范围存续期间，新 Bash 调用只允许前景执行。残留子进程在返回前停止，
  经确认后报告 settled；不能证明停止就关闭准入并报告 unknown。
  此规则覆盖 cwd 和包内脚本，不依靠命令字符串猜测，也不清理其它早先的任务。
- release 幂等删除指定 Run 的临时目录并拒绝迟到安装；关闭身份有有界期限和
  数量上限。普通个人 Skill 与只读系统 Skill 不由该接口删除。
- 启动前清理上次残留；正常退出在执行器及 managed MCP 停止后清理。无法确认
  清理时返回专用错误。未以 SIGKILL 作为稳定测试步骤，重启残留由夹具明确构造。
- 请求正文接收、包大小、执行时限和错误输出都有界；成功返回 settled 和停止
  证据，传输失败不能冒称只读。Trace 记录 Run、摘要和结果，不捕获包正文。

## 验证

| 门禁                  | 结果                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| 本机单元              | 138 项通过，零跳过；严格控制输入、签名、正文超时、请求身份、关闭范围及配额                                      |
| 共享 wire 合同        | 3 项通过；Docker 中每个私有响应再次用同一 schema 校验                                                           |
| 本机及 Linux 静态检查 | Rust fmt、all-targets clippy 通过；根测试源码 lint、格式/链接/存储检查通过                                      |
| Linux 候选构建        | 187 项单元、5 项 UID 1000 执行器集成、1 项 MCP fixture 测试通过，零跳过；release 构建完成                       |
| 真实卷 HTTP           | 双 verifier、错误 action/Agent/签名/正文、真实文件及脚本、冲突/漂移/配额、后台任务、迟到请求、停机/重启清理通过 |

最终项目 antnest-temporary-d4b453f8 使用独立 named volume、网络和唯一候选镜像。
正常停机后、重新启动前就确认临时树消失；重启前人为构造的残留也在 readiness
之前删除。新进程拒绝新签发但绑定旧 execution 的票据，个人 Skill 可继续读取。
没有付费模型或真实凭据，没有重新启动此前验收环境。

私有证据位于 artifacts/verification/skill-discovery-d4-20261001/，不进入 Git
或 Docker 构建上下文。此前失败保留：命令/状态/正文时限测试先失败，再实现；
首轮 Linux 新断言错误地要求 0755，按已有私有文件规则改为 0700 后通过。
首轮也遇到旧 managed 进程观察测试的解析错误，增加字段定位后该测试与后续
真实进程回归均通过；没有将它跳过，也不声称已证明这次偶发错误的根因。
所有本轮容器、网络、卷及候选镜像均已清理，启动前停止资产保持不变。

## 消费者衔接

ACP 消费者必须在派发前持久记录临时范围，再提供真实文件路径；完成、
取消及进程恢复要先回收并确认效果，之后才允许下一 Run 或学习维护。不能复用
D3 的只读恢复规则处理这些文件写入，也不能把 Runtime 接口通过当作消费者完成。

这些要求已由 [D4A](skill-discovery-temporary-consumer-delivery-20261001.md)
完成并通过门禁。[Console D6](skill-discovery-console-delivery-20261001.md)
提升入口及 [DI1](skill-propagation-integration-delivery-20261001.md) 的真实学习、
来源临时使用、授权提升、模板创建及 rebuild/Run 也已通过各自门禁，证据范围分开记录。
