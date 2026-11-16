# 架构与发布契约

数据流固定为 Private dist → GitHub REST → Worker → 设备。ArtifactProvider 通过 `artifact(path, token)` 返回单个已验证产物（dist commit、路径、字节、摘要），未在当前 Manifest 发布的路径返回空值，由 HTTP 层返回 404。路径只能由固定客户端路由映射，并且必须出现在严格校验后的 Manifest；不会开放任意文件读取接口。GitHubArtifactProvider 的 fetch 可注入，使测试可精确模拟故障；auth、manifest 和 HTTP 模块可独立验证。未来若采用 R2，仅在同一接口后读取不可变完整快照，不预建数据库或存储适配器。

审计依据：Private main `5400f92eb3b588ef7a213142db3a7ed39d16feda` 的 docs/publishing.md、docs/security.md、scripts/distribution.py、build-rules.yml；公共 ProxyKit main `10f07b382c201ec4776c420510c3031e68492194` 的 docs/private-integration.md。未修改这两个仓库或 dist。

严格契约与 Python 消费器一致：

- 顶层只有 schema_version、source_commit、generator、versions、rule_sets、files；schema_version=1。
- generator 只有 repository=`KnowSky404/ProxyKit`、commit；两个来源 commit 都是小写 40 位 SHA。
- versions 只有 bun、sing_box、source_format、minimum_reader；三个版本是三段十进制数字；source_format=2；1.10.0 ≤ minimum_reader ≤ sing_box。比较使用数值分段，不按字符串排序。网关不执行 SRS 解码，设备仍需达到该 reader 要求。
- 名称匹配 `[a-z0-9]+(?:-[a-z0-9]+)*`，最长100字符，唯一且严格排序。
- files 严格按 path 排序、唯一，每集合恰有 loon/rules/_.list、quantumultx/filters/_.list、sing-box/rules/*.json 和 *.srs，均在 generated/ 下。每条只有 path、正整数字节 size、小写64位 sha256。
- 重复 JSON 键（包括转义等价键）、未知字段、路径、版本和缺件均拒绝。数值字段使用十进制整数JSON词法（拒绝1.0/1e0），解析深度 ≤32，严格 UTF-8；只读取固定提交树元数据作mode校验，不读取未列出文件正文、不跟随 download_url/重定向。
- 每文件及 manifest ≤1,000,000 字节，Contents API 对象要求 type=file、相同 path、encoding=base64，先以同一dist SHA的Git tree确认manifest及所请求产物为普通blob（100644/100755，拒绝120000符号链接和160000子模块，即使Contents API解引用伪装为file）；同时拒绝Contents显式symlink/submodule标记；严格 Base64 解码并检查 API size、manifest size、SHA-256。SRS 保留 Uint8Array，从不做文本转换。

按需读取流程：先鉴权与设备范围授权、精确路径停用检查（仓库范围只接受 `paths: ["*"]`，否则按精确路径列表授权） → GET 固定 `/git/ref/heads/dist` → 检查 commit SHA → 相同 SHA 可复用元数据，否则读取该 SHA 的 Git tree 和 Manifest → 严格校验 Schema、文件白名单、版本及元数据资源边界 → 查找所请求路径 → 未发布则返回 404，否则仅读取并校验目标文件 → 返回文件。首次冷读取固定 4 次 GitHub 调用；相同版本换文件需 2 次；同文件缓存命中只查 ref 1 次。缺失路径冷读取只需 3 次元数据调用，热读取只查 ref。读取期间 dist 更新不影响本次固定 SHA；下一请求重新解析 ref。source_commit 仍通过 Manifest 校验，但不作为缓存版本。

取消网关自设的 8 组/32 文件及总产物 8,000,000 字节限制，规则组数遵循参考发布契约最多 1000 组。这个上限约束 Manifest 结构，不再决定产物下载次数。树元数据上限为 `1000 × 4 + 64 = 4064` 条目，truncated、重复路径或超限直接拒绝；实际 API JSON 流还受 2,100,000 字节限制。每文件及 Manifest 仍最多 1,000,000 字节。总产物字节数不再累加限制，因为不会同时读取全部产物；Manifest 必须通过完整结构校验，Git tree 必须通过截断、重复路径和条目数检查，不能因过大或截断而忽略部分元数据。原生 fetch 绑定 globalThis，redirect=manual，拒绝所有非200状态；不重试，每个上游请求3秒，一次文件读取总计15秒。目标为Workers Free，不设置付费专用CPU上限；合成规模测试证明按需读取和调用次数，不代表生产CPU、内存或并发容量。

模块只缓存一份版本元数据和最近一个验证后的产物，产物字节最多1MB；元数据、JSON/Base64、复制和并发请求另占内存。换文件会替换字节缓存，不能随访问路径无限增长。没有跨请求共享Promise/Response/流，避免Workers请求上下文I/O错误。缓存隔离到单实例，非持久、不跨实例共享，可能随时丢失。并发冷加载可能重复读取元数据；高并发需在部署侧限流并实测，再考虑存储升级。

每次请求重新认证授权并重新解析 dist，不使用TTL内旧ref。发现新SHA先清除旧缓存。目标文件只在其声明大小及SHA-256都验证后才可返回，304同样要求完成必要校验；任何读取失败503，无旧版本回退。删除路径不从旧版本补齐。与旧的完整快照策略相比，不再读取或校验未请求的产物正文：其他格式或规则正文损坏、缺失、符号链接不会阻断当前目标；请求它们时仍逐一拒绝。全局 Manifest 格式、版本、文件白名单或元数据不合法仍然拒绝。并发请求以各自ref解析时刻为版本边界，不能撤回已经在途的下载。删除源YAML但当前dist仍保留产物时，订阅仍存在；紧急撤销必须通过DEVICE_AUTH禁用。

GitHub 403/429遵守Retry-After（整数秒或HTTP日期，无有效值用60秒），实例内只存退避截止时间并返回503/Retry-After，无自动重试、无旧版响应。其他网络/权限/404/5xx/不兼容也503。health只表示Worker进程可响应，不查询上游或宣称文件可用。

依据：[GitHub Contents API](https://docs.github.com/en/rest/repos/contents)、[Git tree模式与截断契约](https://docs.github.com/en/rest/git/trees)、[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[当前官方Vitest插件](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)。当前官方推荐@cloudflare/vitest-plugin（替代旧pool包），使用最新相容稳定版本并锁定。Worker源码不导入Node模块、不配置nodejs_compat；测试工具自身的兼容环境不作为生产兼容性证明，另用cf本地启动和打包验证。
