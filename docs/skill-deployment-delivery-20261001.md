# Skill 学习与动态传播：常规部署接线验收

2026-10-01：普通 Compose 配置已跑通已交付的四步 Skill 传播流程。
本批只修改部署配置、根 tests 和文档，没有修改服务业务实现或增加接口。
它消费此前 [DI1 完整链路](skill-propagation-integration-delivery-20261001.md)
及各服务所属门禁，配置规则见[部署合同](../contracts/skill-registry/deployment.md)。

## 修复内容

此前完整业务回归使用测试配置覆盖文件提供来源认证和维护签名；普通
`compose.yaml` 没有转发这些已有选项，常规部署因此不能直接启用该流程。
先添加配置合同测试，确认缺少 ACP Registry 地址及 Controller 学习策略地址，
再补齐接线并验证通过，失败证据保留。
常规 `docker-build-stage3` 同样漏掉 Registry 镜像；新增构建计划测试复现后补入
该镜像，使空白部署的标准构建入口覆盖当前服务范围。

ACP 只接收私有签名身份；RC 接收公开验证集合并在新建/重建时冻结进 Runtime。
`ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN` 同时连接 ACP 与 Registry 的私有来源地址
及匹配 bearer，正式 Registry API bearer 仍然独立。来源选项为空时，动态发现
关闭，正式包托管和模板预设交付继续可用。个人学习可以独立启用。
Registry 只连接内部开发网络及其独立数据库网络，不加入 Runtime 管理或 Egress
网络，也不向宿主机发布端口。

配置示例和使用说明见[常规部署指南](skill-deployment.md)。现有 Runtime 不会
因 RC 环境变量变化获得新公钥，仍需显式重建。本批未生成实际部署凭据，未修改
模型 Provider 配置，也未启动此前停止的验收部署。

## 实际验收

复现入口是 `make test-skill-deployment` 和 `make e2e-skill-deployment`。
[配置测试](../tests/integration/skill-registry/deployment-config.test.mjs)不读取
实际 `.env`，只使用内存生成的合成签名身份。Docker 流程复用
[完整业务验收](../tests/e2e/skill-learning/automatic-flow.test.mjs)，新增的
[部署覆盖](../tests/e2e/skill-learning/deployment.compose.yaml)只选择候选镜像
和本地确定性模型，不设置来源/学习认证；网络隔离沿用已有 E2E 基础设施。

| 门禁                    | 结果                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| 普通 Compose 与构建入口 | 6 项通过，验证默认关闭、匹配两侧 bearer、私钥隔离、学习独立开启、网络/端口及 Registry 构建 |
| 完整 Docker 业务链路    | `antnest-lifecycle-793189a3` 通过，约 230 秒，9 组业务检查                                 |
| 自动来源与临时使用      | 真实自动学习生成/更新，模型 find/load；多文件临时范围覆盖完成、取消和正常重启后的清理      |
| 用户提升与模板冻结      | 真实身份登录、浏览器预览并显式发布不同摘要的 v1/v2；发布 v2 不热更新既有 v1                |
| 实际预设 Run            | 6 个完成，包括 Registry 离线使用、两 Agent 显式重建及来源失效后的正式版本独立使用          |
| Trace 与浏览器          | 两次学习、来源检索、临时 install/release 及六个预设 Run 父链通过；模型拒绝和浏览器错误为空 |
| 清理                    | 前后 Docker 资源清单相同：17 个停止容器、0 个运行容器、15 个网络、11 个卷                  |

自动学习来源是单文件 SKILL.md；多文件临时交付采用同一部署中正常上传的正式
合成包，未扩大自动生成能力的声明。物理时钟告警沿用已确定的阶段验收边界。
此次使用本地确定性模型，经正常服务适配器调用，没有付费推理或手动凭据重放。

私有证据保存在 `artifacts/verification/skill-deployment-20261001/`，最终门禁索引
为 `admission.json`。组合报告保存在
`artifacts/verification/skill-learning/antnest-lifecycle-793189a3.json`；本批项目
子目录包含浏览器截图、原始 Trace、业务结果及清理清单，均排除在 Git 和 Docker
构建上下文外。当前结论只覆盖 Skill 部署与四步传播链路。
