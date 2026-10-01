# Runtime 工具调用习惯优化

本轮修复真实 DeepSeek 演示中的文件工具参数问题。公开 MCP 仍为四个内置工具，
工具目录由 Runtime 提供，ACP 不另造模型工具目录。开发阶段直接更新调用合同，
不保留旧嵌套参数作为第二套公开接口。

参考固定为 Hermes `f42f579cf8bac4918ac9599bece71618afadd846` 的
[文件工具](https://github.com/NousResearch/hermes-agent/blob/f42f579cf8bac4918ac9599bece71618afadd846/tools/file_tools.py)，
以及 pi `d2931ad3d5bf6936fbdfa5dfc81fb32f875499b2` 的
[read](https://github.com/earendil-works/pi/blob/d2931ad3d5bf6936fbdfa5dfc81fb32f875499b2/packages/coding-agent/src/core/tools/read.ts)、
[write](https://github.com/earendil-works/pi/blob/d2931ad3d5bf6936fbdfa5dfc81fb32f875499b2/packages/coding-agent/src/core/tools/write.ts)
和 [edit](https://github.com/earendil-works/pi/blob/d2931ad3d5bf6936fbdfa5dfc81fb32f875499b2/packages/coding-agent/src/core/tools/edit.ts)。
采用它们共同的字符串路径、按行分页、可省略读取范围与 shell 默认工作目录；
精确编辑沿用 Hermes 的 `old_string` / `new_string`。

## 冻结合同

[公开输入](../contracts/runtime/builtin-tools.schema.json) 规定：

- `read({path, offset?, limit?})`：offset 从第 1 行开始，默认 1；limit 默认
  2000 行，最大 20000 行。结果保留 UTF-8 原文，最多 50 KiB，按完整行截取；
  截取时返回 `next_offset`，结束时为 null。单行超过预算明确报错，避免无法
  推进的分页。原始文件仍受既有 8 MiB 上限约束。
- `write({path, content})`：创建父目录，原子写入完整正文。
- `edit({path, old_string, new_string})`：精确替换唯一匹配，保持现有原子写入。
- `bash({command, working_dir?, timeout_ms?, env?})`：默认工作目录为工作区，
  默认超时 120000 毫秒；额外环境变量和既有执行隔离规则保持一致。

path 为字符串：相对路径、`~/` 和 `/workspace/` 指向工作区，`/skills/` 指向
只读系统 Skill。Runtime 转为内部 named root，仍拒绝越界、`..`、NUL、软连接
和特殊文件；write/edit 以及 bash 工作目录不能指向系统 Skill。运行时信息的
内部身份定位仍保留 root/path，ACP 向模型展示可直接调用的字符串路径。

## 按服务交付

| 批次 | 所有者          | 工作与门禁                                                                           | 状态                                                                       |
| ---- | --------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| T0   | shared contract | 输入 schema、合同样例、交付边界                                                      | 5 项合同检查通过                                                           |
| T1   | Runtime         | 参数、路径解析、按行读取与默认值；单元/合同/官方 SDK HTTP 组件及 Linux Docker        | Mac 129 项；Linux 175 项、executor 4 项、SDK 夹具 1 项及候选镜像构建通过   |
| T2   | ACP             | 上下文中的路径、学习内部读取、先前 Skill 使用扫描、工具呈现和校验反馈；单元/组件门禁 | 1025 项单元、168 项 HTTP/组件、43 项 PostgreSQL 检查及 typecheck/lint 通过 |
| T3   | integration     | 更新真实调用资产，Docker 验证四工具及 Skill 学习、notice、后续读取                   | 合同与新模型夹具 6 项、现有模型夹具 110 项及 Docker 全链路通过             |

## 集成验收

`make e2e-runtime-tool-usability` 在隔离项目 `antnest-lifecycle-e5c9b393`
通过：两次来源 Run 各顺序完成 write/edit/read/bash，所有 8 次真实 Runtime
attempt 均为 completed，两个 Run 均以 `end_turn` 正常结束。read 只传字符串
path，bash 只传 command；模型夹具核对 edit 后的实际读回内容。来源继续进入
既有 debug 学习流程，创建与更新同一个个人 Skill，发送 SDK notice，经断线
和 View 补读恢复；移除 debug、重启 ACP 并等待 Controller 配置同步后，后续
Run 真实读取两条规则。学习候选 ZIP 也通过真实 Registry 包校验。

创建与更新的学习 Trace 分别为 `dce9301c300f80d9dcc72e60a0f0da98`
和 `5ddd182df5e3daf0e7cd6e9ff2e4c5c1`，有 201/210 个 span，覆盖 task、review、
model、validation、apply 和 Runtime maintenance HTTP；父子引用完整，未捕获
模型正文。隔离项目的 Compose/RC 容器、网络和卷均已清理。

真实模型旧演示仍保留原始失败记录。上述确定性模型验证工具合同与服务流程；
后续真实模型复测单独记录在下节。

## 真实模型复测

用户要求重新测试后，在受控 Chrome 的新 Session 中使用 DeepSeek Flash /
Thinking Off，执行文件写入、读回、精确编辑、再次读回和 `pwd`。前景先读取
既有个人 Skill，随后完成五项指定操作：六次 Runtime attempt 全部 completed，
没有工具失败更新，Run 以 `end_turn` 正常结束。实际文件为
`demo/tool-retest-20260930.md`，标题和三条步骤保持完整，状态为“已校验”。

复测发现历史暂停任务恢复后抛出异常，但原恢复入口未将已恢复的 running
任务重新暂停，导致它占住全局学习名额。本批在 ACP task processor 中补齐
异常传播前的持久暂停，保留原诊断、模型回执与费用限制，没有手工修改验收
数据库。两项新增测试先失败再通过；1027 项单元、168 项 HTTP/组件、61 项
PostgreSQL 恢复检查、typecheck/lint 和隔离 Docker 失败恢复回归全部通过。
隔离项目 `antnest-lifecycle-b73d0997` 的容器、网络和卷已核验清零。

部署修复后，本次已入队的 debug 学习任务通过正常 worker 继续，一次复盘
使用 1991 输入 / 591 输出 token，生成并安装
`workspace-write-read-edit-verify`。官方 MCP SDK 核验安装正文与持久候选
逐字一致，演示文件与预期内容一致；页面显示新增结果和正确来源会话。
临时 debug 已关闭，ACP 重启后，正常 Agent View 和 Chrome 仍恢复该结果。
历史失败提示来自旧任务，不属于本次已完成任务。

- Session：`session_06f6ee46d3a6a63fc9583fa4b578c60f`。
- 来源 Run：`run_525828a923a342eb3db64da10fe27838`。
- 学习任务：`learn_8950372f3e2c780798faf5d2c7b7e0ee`，版本 2，completed。
- 持久变更：`eb2d0896-875d-434b-a01b-4fa6a9cb50cc`。
- [前景 Trace](http://127.0.0.1:16686/trace/b87395b55901a65e84fc8eb5fc2223e4)：
  590 个 span，包含六次工具调用，无 error span，父子引用完整。
- [学习 Trace](http://127.0.0.1:16686/trace/a1c404e850d24495903b2cc2c2840404)：
  182 个 span，包含 task/review/model/validation/apply 和三次成功的 Runtime
  maintenance HTTP，父子引用完整；两条 Trace 均未捕获模型正文。

原始回执、Trace、SDK 读回与页面截图保存在
`artifacts/verification/tool-usability-20260930/real-retest/`，不纳入 Git。

## 开发验收环境同步

`antnest-acceptance-20260930` 已通过正常 Admin/Gateway API 将原模板发布为
修订 2，并重建原 `Acceptance Demo Agent`。Runtime generation 2 使用上述通过
Linux 门禁的镜像，ACP 使用本轮集成通过的镜像；服务均健康、Agent 可执行。
原模型及预设 Skill 引用保持一致。

官方 MCP SDK 从已部署 ACP 容器探测新 Runtime：read/write/edit 的 path 均为
字符串，read 仅需 path，bash 仅需 command。实际读取演示文件、个人 Skill 和
系统 Skill，返回内容与重建前摘要一致；最小 bash 的 cwd 为 `/workspace`。
普通 Agent View 恢复原 Session 的已学习结果。临时学习 debug 仍关闭。

部署前配置、生命周期回执、前后文件摘要、SDK 探测及 View 证据保存在本轮
私有证据目录，未通过手动模型调用进行验收。

不在本轮新增搜索工具、图片工具、模糊编辑、审批系统或候选执行环境。
私有参考源码与回归证据存放于 `artifacts/verification/tool-usability-20260930/`。
