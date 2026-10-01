# Antnest Platform

[![CI](https://github.com/tf4fun/antnest-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/tf4fun/antnest-platform/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

Antnest Platform 是一个面向组织运行 AI Agent 的平台。每个 Agent 拥有独立的
Runtime 容器、带出口策略的稳定网络身份，以及由控制面管理的持久生命周期。
用户在浏览器工作区中通过 [Agent Client Protocol（ACP）](https://agentclientprotocol.com/)
与 Agent 对话；管理员在管理控制台中管理身份、模型提供商、模板、Skill 和 Agent。

平台以 Docker 为优先部署目标，由一组小而独立的服务组成。每个服务只拥有自己的数据，
服务之间只通过与语言无关的契约通信。

## 功能

- **隔离的 Agent Runtime**：每个 Agent 一个容器，通过 MCP 暴露工作区，内置
  `read`、`write`、`edit`、`bash` 工具以及平台托管的 stdio MCP 服务器。
  Agent 命令以非特权用户运行。
- **按 Agent 的网络策略**：Runtime 流量经隧道进入 Runtime Egress，后者为每个
  Agent 分配稳定地址，并按版本化策略放行或拒绝每条连接。
- **ACP v1 / v2 执行**：Agent ACP Service 负责 Session、Run、模型与工具执行、
  权限确认、计划、多模态输入、成本统计和执行审计。
- **持久生命周期**：Agent Controller 通过 Temporal 工作流完成创建、重建、启用、
  停用和删除，并发布执行配置。
- **企业身份**：组织、用户、用户组、本地登录、OIDC 与 SCIM 2.0 同步；身份被撤销时
  自动下线其 Agent。
- **Skill**：Skill Registry 托管不可变的 Skill 包；模板固定引用精确版本，Runtime
  以只读方式接收。Agent 也可以在管理员策略下自动学习和传播 Skill。
- **可观测性**：OpenTelemetry 覆盖 HTTP、RPC、数据库和工作流边界，可在 Jaeger 中查看。

## 架构

```text
                      浏览器（Admin Console / Agent UI）
                                     |
                               Edge Gateway（唯一公网入口）
              +----------------------+---------------------+
              |                      |                     |
        Admin Console BFF        Agent UI bridge     Identity Service
              |                      |
              +-----------+----------+
                          |
      Agent Controller ---+--- Agent ACP Service ---> 模型提供商
        |       |                    |
        |       +--> Skill Registry  +--> Antnest Runtime（每个 Agent 一个，MCP）
        |                                      |
        +--> Runtime Controller --> Docker     +--> Runtime Egress --> 外部网络
        +--> Runtime Egress（策略）
```

| 组件 | 语言 | 职责 |
| --- | --- | --- |
| [Antnest Runtime](runtimes/antnest-runtime/README.md) | Rust | 在容器内执行单个 Agent 的工具调用和文件操作 |
| [Runtime Egress](services/runtime-egress/README.md) | Rust | Agent 网络地址、出口策略和数据包转发 |
| [Runtime Controller](services/runtime-controller/README.md) | Go | 在 Docker 上为每个 Agent 实现并观测一个 Runtime Environment |
| [Agent Controller](services/agent-controller/README.md) | Go | Agent 生命周期、配置、提供商凭据和执行配置发布 |
| [Agent ACP Service](services/agent-acp-service/README.md) | TypeScript | ACP Session、Run、模型与工具执行、执行审计 |
| [Identity Service](services/identity-service/README.md) | Go | 组织、用户、本地登录、OIDC、SCIM 和访问凭据 |
| [Edge Gateway](services/edge-gateway/README.md) | Go | 浏览器入口、会话、准入、路由和安全响应头 |
| [Admin Console](services/admin-console/README.md) | Go + React | 管理员应用及其轻量 BFF |
| [Agent UI](services/agent-ui/README.md) | TypeScript + React | 终端用户对话工作区及其服务端 bridge |
| [Skill Registry](services/skill-registry/README.md) | Go | 不可变 Skill 包、版本和分发 |

规划中的组件：Channel Manager（外部聊天渠道）、Task Scheduler（定时任务）以及
Runtime Controller 的 Kubernetes 适配器，见 [docs/stage-4-services.md](docs/stage-4-services.md)。

服务归属、身份标识和依赖方向见 [docs/service-layout.md](docs/service-layout.md)，
接口契约见 [contracts/](contracts/README.md)。

## 快速开始

环境要求：Linux 或 macOS，安装 Docker Engine、Compose v2 和 GNU Make。
以下步骤仅用于本地体验。

```bash
git clone https://github.com/tf4fun/antnest-platform.git
cd antnest-platform
cp .env.example .env

# 构建全部镜像（串行构建，内存占用更可控）
COMPOSE_PARALLEL_LIMIT=1 make -j1 docker-build-stage3

# 启动平台和 Jaeger
ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF=antnest/antnest-runtime:local \
  docker compose -f compose.yaml -f compose.stage3.yaml \
  --profile stage3 --profile observability up -d --wait
```

然后访问：

- Admin Console：<http://127.0.0.1:8090>
- Agent UI：<http://127.0.0.1:8090/workspace/>
- Jaeger：<http://127.0.0.1:16686>

使用组织 `engineering`、邮箱 `admin@example.com`、密码 `antnest-admin-dev` 登录。
先连接模型提供商，再创建模板，最后创建 Agent。只有 Edge Gateway 对外发布应用端口。

> `.env.example` 中的值是公开的开发默认值。在任何其他环境中使用前，请替换全部
> 密码、令牌和加密密钥，详见 [SECURITY.md](SECURITY.md)。

停止：`docker compose -f compose.yaml -f compose.stage3.yaml --profile stage3
--profile observability down`，加 `-v` 会同时删除数据。

配置、密钥、就绪检查、备份和故障排查请参阅
[单节点运维手册](docs/docker-single-node-operations.md) 和
[备份与恢复指南](docs/docker-backup-restore.md)（英文）。

## 开发

工具链：Go 1.27.1、Rust 1.98.1、Node.js 24.21.0 和 Docker。先安装锁定版本的 Node 依赖：

```bash
npm --prefix services/agent-acp-service ci
npm --prefix services/admin-console/web ci
npm --prefix services/agent-ui/web ci
```

常用命令（在仓库根目录执行）：

```bash
make fmt-check        # Go、Rust、TypeScript 格式检查
make lint             # golangci-lint、cargo clippy、ESLint 和类型检查
make test             # 不依赖运行中环境的单元测试与集成测试
make test-postgres    # 使用一次性 PostgreSQL 运行持久化测试
make docker-build-stage3
make e2e-stage3       # 一次性完整 Docker 验收
```

每个服务的 README 列出了各自的构建、测试和配置说明。[测试指南](tests/README.md)
说明测试目录结构和 Docker E2E 目标。E2E 目标会创建一次性 Compose 项目，并在成功或
失败时清理；请一次只运行一个。

开发和测试用的 Compose 共用一个 PostgreSQL 实例以节省资源，但每个服务仍有独立的
数据库、角色和迁移，服务之间不读取彼此的表。

## 文档

详细文档均为英文，入口见 [README.md](README.md#documentation)。

## 参与贡献

欢迎贡献。开发流程和评审要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按
[SECURITY.md](SECURITY.md) 私下报告。

## 许可证

Antnest Platform 以 [MIT 许可证](LICENSE) 发布。
