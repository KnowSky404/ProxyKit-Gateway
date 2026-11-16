# 架构与发布契约

数据流固定为 Private dist → GitHub REST → Worker → 设备。ArtifactProvider 通过 `artifact(path, token, ttlSeconds)` 返回单个已验证产物（dist commit、路径、字节、摘要），未在当前 Manifest 发布的路径返回空值，由 HTTP 层返回 404。路径只能由固定客户端路由映射，并且必须出现在严格校验后的 Manifest；不会开放任意文件读取接口。`catalog(token, ttlSeconds)`复用相同的固定版本元数据读取流程，仅返回已校验Manifest的资源声明，不预取产物正文。HTTP集合路由先认证并确认设备在对应客户端下有授权范围，再过滤客户端、精确路径和停用项后生成JSON；列表内容不存入共享缓存，避免跨设备泄露。GitHubArtifactProvider 的 fetch 可注入，使测试可精确模拟故障；auth、manifest 和 HTTP 模块可独立验证。未来若采用 R2，仅在同一接口后读取不可变完整快照，不预建数据库或存储适配器。

审计依据：Private main `5400f92eb3b588ef7a213142db3a7ed39d16feda` 的 docs/publishing.md、docs/security.md、scripts/distribution.py、build-rules.yml；公共 ProxyKit main `10f07b382c201ec4776c420510c3031e68492194` 的 docs/private-integration.md。未修改这两个仓库或 dist。

严格契约与 Python 消费器一致：

- 顶层只有 schema_version、source_commit、generator、versions、rule_sets、files；schema_version=1。
- generator 只有 repository=`KnowSky404/ProxyKit`、commit；两个来源 commit 都是小写 40 位 SHA。
- versions 只有 bun、sing_box、source_format、minimum_reader；三个版本是三段十进制数字；source_format=2；1.10.0 ≤ minimum_reader ≤ sing_box。比较使用数值分段，不按字符串排序。网关不执行 SRS 解码，设备仍需达到该 reader 要求。
- 名称匹配 `[a-z0-9]+(?:-[a-z0-9]+)*`，最长100字符，唯一且严格排序。
- files 严格按 path 排序、唯一，每集合恰有 loon/rules/_.list、quantumultx/filters/_.list、sing-box/rules/*.json 和 *.srs，均在 generated/ 下。每条只有 path、正整数字节 size、小写64位 sha256。
- 重复 JSON 键（包括转义等价键）、未知字段、路径、版本和缺件均拒绝。数值字段使用十进制整数JSON词法（拒绝1.0/1e0），解析深度 ≤32，严格 UTF-8；只读取固定提交树元数据作mode校验，不读取未列出文件正文、不跟随 download_url/重定向。
- 每文件及 manifest ≤1,000,000 字节，Contents API 对象要求 type=file、相同 path、encoding=base64，先以同一dist SHA的Git tree确认manifest及所请求产物为普通blob（100644/100755，拒绝120000符号链接和160000子模块，即使Contents API解引用伪装为file）；同时拒绝Contents显式symlink/submodule标记；严格 Base64 解码并检查 API size、manifest size、SHA-256。SRS 保留 Uint8Array，从不做文本转换。

按需读取流程：先鉴权与设备范围授权、精确路径停用检查（仓库范围只接受 `paths: ["*"]`，否则按精确路径列表授权） → 校验TTL配置 → 有效期内复用已验证的版本元数据，否则GET固定 `/git/ref/heads/dist` 并检查commit SHA → 同SHA保留元数据和最近文件字节，否则读取该SHA的Git tree/Manifest并严格验证 → 目录按设备权限过滤，文件按需读取、验证后返回。所有同一次读取的元数据和目标正文仍绑定同一SHA；source_commit仍校验但不作为缓存版本。

## 元数据TTL方案

`METADATA_CACHE_TTL_SECONDS`是非敏感文本绑定，默认60秒；接受能安全换算为整数毫秒的非负整数字符串，0表示每次检查ref。非法配置在返回私人数据前503。有效期从成功版本检查的开始时刻计时，不随目录/文件缓存命中续期，系统时钟回退到缓存检查时间之前时也必须重新检查版本。请求过程中选择的SHA保持不变，在途请求与发布传播仍有平台边界。

| 场景                               | GitHub调用次数                                      |
| ---------------------------------- | --------------------------------------------------- |
| 首次目录/文件读取                  | 目录3次，文件4次                                    |
| 有效期内列目录或读取最近已缓存文件 | 0次                                                 |
| 有效期内读取当前版本的其他文件     | 1次（只取目标文件）                                 |
| 到期后版本未变                     | 1次ref检查，再按是否已有目标字节决定是否取文件      |
| 到期后版本变化                     | 重新验证tree/Manifest，按需取目标；不补齐已删除文件 |

规则新增、修改和删除在默认缓存窗口内可能延迟约60秒可见；设备凭据、授权与停用状态始终每次读取当前绑定并执行，认证失败不触及元数据缓存或GitHub。HTTP响应继续`private,no-store`；缓存只保存实例内纯数据，不保存设备过滤后的响应、完整带KEY的URL、Response、流或跨请求Promise。目录JSON每次按当前权限生成并计算ETag，不能通过304绕过策略变化。

到期刷新失败（网络、限流、未知Schema、损坏元数据等）必须503并丢弃旧元数据和字节，不能延长已过期有效期或返回旧数据；恢复后重新验证。缺失路径在有效期内可以按当前已校验Manifest返回404，发布新增路径会在刷新后可见。TTL为0时保留原先每次ref检查语义。

取消网关自设的 8 组/32 文件及总产物 8,000,000 字节限制，规则组数遵循参考发布契约最多 1000 组。这个上限约束 Manifest 结构，不再决定产物下载次数。树元数据上限为 `1000 × 4 + 64 = 4064` 条目，truncated、重复路径或超限直接拒绝；实际 API JSON 流还受 2,100,000 字节限制。每文件及 Manifest 仍最多 1,000,000 字节。总产物字节数不再累加限制，因为不会同时读取全部产物；Manifest 必须通过完整结构校验，Git tree 必须通过截断、重复路径和条目数检查，不能因过大或截断而忽略部分元数据。原生 fetch 绑定 globalThis，redirect=manual，拒绝所有非200状态；不重试，每个上游请求3秒，一次文件读取总计15秒。目标为Workers Free，不设置付费专用CPU上限；合成规模测试证明按需读取和调用次数，不代表生产CPU、内存或并发容量。

模块只缓存一份版本元数据和最近一个验证后的产物，产物字节最多1MB；元数据、JSON/Base64、复制和并发请求另占内存。换文件会替换字节缓存，不能随访问路径无限增长。没有跨请求共享Promise/Response/流，避免Workers请求上下文I/O错误。缓存隔离到单实例，非持久、不跨实例共享，可能随时丢失。并发冷加载可能重复读取元数据；高并发需在部署侧限流并实测，再考虑存储升级。

每次请求重新认证授权，版本检查按照上述TTL执行。过期检查发现新SHA先清除旧缓存。目标文件只在其声明大小及SHA-256都验证后才可返回，304同样要求完成必要校验；任何读取失败503，无旧版本回退。删除路径不从旧版本补齐。与旧的完整快照策略相比，不再读取或校验未请求的产物正文：其他格式或规则正文损坏、缺失、符号链接不会阻断当前目标；请求它们时仍逐一拒绝。全局 Manifest 格式、版本、文件白名单或元数据不合法仍然拒绝。并发请求以各自选定的有效缓存版本或ref解析时刻为版本边界，不能撤回已经在途的下载。删除源YAML但当前dist仍保留产物时，订阅仍存在；紧急撤销必须通过DEVICE_AUTH禁用。

GitHub 403/429遵守Retry-After（整数秒或HTTP日期，无有效值用60秒），实例内只存退避截止时间并返回503/Retry-After，无自动重试、无旧版响应。其他网络/权限/404/5xx/不兼容也503。health只表示Worker进程可响应，不查询上游或宣称文件可用。

依据：[GitHub Contents API](https://docs.github.com/en/rest/repos/contents)、[Git tree模式与截断契约](https://docs.github.com/en/rest/git/trees)、[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[当前官方Vitest插件](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)。当前官方推荐@cloudflare/vitest-plugin（替代旧pool包），使用最新相容稳定版本并锁定。Worker源码不导入Node模块、不配置nodejs_compat；测试工具自身的兼容环境不作为生产兼容性证明，另用cf本地启动和打包验证。
