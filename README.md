# ProxyKit-Gateway

基于 Cloudflare Workers 的私人规则分发网关。向个人 Loon、Quantumult X、sing-box 设备提供独立鉴权、固定仓库或精确路径授权和绑定不可变版本、逐文件校验的规则下载。

```text
ProxyKit-Private / dist → 固定 GitHub REST API → Worker → 已授权设备
                            ↑ 仅校验所请求文件 SHA-256
```

[ProxyKit](https://github.com/KnowSky404/ProxyKit) 维护公共规则及生成器；ProxyKit-Private 保存私人源、构建并发布四类产物。本仓库只负责读取与分发。公共规则继续直连 ProxyKit。保留原有 AGPL LICENSE。

技术栈：TypeScript、Workers 原生 Fetch/Web Crypto、cf CLI、Bun、Cloudflare 官方 Vitest 插件。无运行时第三方依赖，无数据库或前端，不生成/转换规则、不编译 SRS。

```text
src/
  index.ts           Worker 入口
  app.ts             HTTP 路由与条件请求
  auth/devices.ts    摘要认证、设备授权与停用
  providers/github.ts ArtifactProvider / GitHub 按需文件读取与有界内存缓存
  manifest/          严格 JSON / Schema / 摘要校验
  config/contract.ts 固定路径和资源上限
  http/errors.ts     脱敏错误、安全响应头
scripts/device-token.ts  本地设备凭据生成工具
tests/                  合成数据的单元、运行时集成、安全回归测试
docs/                   架构、API、安全、部署、客户端与验证记录
.github/workflows/       CI 和手动部署
```

本地开发（Bun 1.4.4；cf/Vitest 使用 Node.js 22.18+，CI 推荐 Node 24）：

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
# 在私人终端编辑 .dev.vars，填入自己的运行时 Secrets
bun run dev
```

本地默认 HTTPS，客户端须信任开发证书。健康检查不需 Secrets：`https://localhost:8787/v1/health`。未配置有效认证时私人资源始终拒绝，不返回示例规则。本地开发服务器请求日志可能显示 URL：本地测试使用 Bearer；不要将真实 URL Token 粘贴到调试工具。

| 配置                                             | 用途                                   | 保存位置                           |
| ------------------------------------------------ | -------------------------------------- | ---------------------------------- |
| `GITHUB_READ_TOKEN`                              | 仅私人仓库 Contents: Read              | Worker Secret / 本地忽略文件       |
| `DEVICE_AUTH`                                    | 设备摘要、传输模式、授权路径、停用路径 | Worker Secret / 本地忽略文件       |
| `ALLOW_URL_TOKENS`                               | 允许独立 URL 凭据，当前启用            | cloudflare.config.ts               |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | 手动部署身份与账号                     | 私人终端 / Actions production 环境 |

```sh
bun run check
bun audit
bun run types
```

[部署文档](docs/deployment.md) 包含只读 GitHub 凭据、Secret 初始化、设备生成/轮换/撤销和手动发布步骤。候选版本工作流只接受 main 上的显式 workflow_dispatch，不切换流量。当前启用 workers.dev，关闭预览 URL；部署前检查 Cloudflare 缓存与日志设置。

API 示例（占位值）：

```sh
curl --fail --header 'Authorization: Bearer DEVICE_TOKEN_PLACEHOLDER' \
  https://gateway.example.com/v1/private/loon/example.list
```

REST集合接口：携带URL专用KEY访问 `/v1/private/loon?key=DEVICE_URL_TOKEN_PLACEHOLDER` 可获得 `{ "resources": [{ "name": "example.list", "path": "/v1/private/loon/example.list" }] }`；`quantumultx`、`sing-box`同理。列表仅包含设备有权访问且未停用的资源，路径不包含KEY；访问具体文件时继续携带原凭据。也支持Bearer、HEAD和鉴权后的304。目录只读取发布元数据，不下载规则正文。

新设备默认使用 `paths: ["*"]` 授权固定私人仓库内全部当前及未来发布的规则；原有精确路径授权保持不变。规则发布到 `dist` 后自动生效，新增规则只需替换订阅路径，删除后对应地址返回 404，无需重新部署或更新授权。支持 GET/HEAD、鉴权后的 ETag/304。所有私人响应 `private, no-store`。完整列表见 [API](docs/api.md)，客户端配置见 [客户端示例](docs/client-examples.md)。

每次订阅只下载目标文件，不下载其他规则或格式。冷读取固定 4 次 GitHub 调用（dist ref、Git tree、Manifest、目标文件）；同版本换文件需 2 次，同文件命中缓存只查 ref 1 次。请求数不随规则组数增长。取消网关额外的 8 组/总产物 8 MB 限制，遵循发布者最多 1000 组的 Schema v1；每文件/Manifest ≤1,000,000 字节，树元数据最多 4064 条目，API JSON ≤2,100,000 字节。缓存保留版本元数据和最近一个验证后的文件，文件字节最多 1 MB。每个上游请求 3 秒、单次文件读取总计 15 秒，不重试。目标为 Workers Free，生产 CPU/并发容量仍须实测。每次授权后重新解析 dist，不使用旧版本回退；Manifest 无效、目标文件损坏、超限或上游失败返回 503，未发布或已删除的授权路径返回 404。

已验证能力与证据见 [验证记录](docs/verification.md)：自动化测试覆盖全部四类响应、字节完整性、权限与上游故障；历史实现使用现有 gh 身份完成了真实私人 API 只读验证；当前版本的生产部署与 HTTP 验证以对应 PR 交付报告为准。未验证真实设备和中国大陆网络，不能将模拟响应测试解释为真机兼容性认证。

后续优先：Loon/QX/sing-box 真机与大陆可达性验证、根据实测 API 配额和负载再决定是否升级发布契约或接入 R2。更多边界与取舍见 [架构](docs/architecture.md) 和 [安全](docs/security.md)。
