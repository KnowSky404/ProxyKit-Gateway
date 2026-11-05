# 架构与发布契约

数据流固定为 Private dist → GitHub REST → Worker → 设备。ArtifactProvider 只暴露完整 Snapshot（dist commit、source commit、经过验证的路径/字节/摘要），不会暴露任意文件读取接口。GitHubArtifactProvider 的 fetch 可注入，使测试可精确模拟故障；auth、manifest 和 HTTP 模块可独立验证。未来若采用 R2，仅在同一接口后读取不可变完整快照，不预建数据库或存储适配器。

审计依据：Private main `5400f92eb3b588ef7a213142db3a7ed39d16feda` 的 docs/publishing.md、docs/security.md、scripts/distribution.py、build-rules.yml；公共 ProxyKit main `10f07b382c201ec4776c420510c3031e68492194` 的 docs/private-integration.md。未修改这两个仓库或 dist。

严格契约与 Python 消费器一致：

- 顶层只有 schema_version、source_commit、generator、versions、rule_sets、files；schema_version=1。
- generator 只有 repository=`KnowSky404/ProxyKit`、commit；两个来源 commit 都是小写 40 位 SHA。
- versions 只有 bun、sing_box、source_format、minimum_reader；三个版本是三段十进制数字；source_format=2；1.10.0 ≤ minimum_reader ≤ sing_box。比较使用数值分段，不按字符串排序。网关不执行 SRS 解码，设备仍需达到该 reader 要求。
- 名称匹配 `[a-z0-9]+(?:-[a-z0-9]+)*`，最长100字符，唯一且严格排序。
- files 严格按 path 排序、唯一，每集合恰有 loon/rules/_.list、quantumultx/filters/_.list、sing-box/rules/*.json 和 *.srs，均在 generated/ 下。每条只有 path、正整数字节 size、小写64位 sha256。
- 重复 JSON 键（包括转义等价键）、未知字段、路径、版本和缺件均拒绝。数值字段使用十进制整数JSON词法（拒绝1.0/1e0），解析深度 ≤32，严格 UTF-8；只读取固定提交树元数据作mode校验，不读取未列出文件正文、不跟随 download_url/重定向。
- 每文件及 manifest ≤1,000,000 字节，Contents API 对象要求 type=file、相同 path、encoding=base64，先以同一dist SHA的Git tree确认manifest及每个产物为普通blob（100644/100755，拒绝120000符号链接和160000子模块，即使Contents API解引用伪装为file）；同时拒绝Contents显式symlink/submodule标记；严格 Base64 解码并检查 API size、manifest size、SHA-256。SRS 保留 Uint8Array，从不做文本转换。

快照流程：先鉴权与路径授权 → GET 固定 `/git/ref/heads/dist` → 检查 commit SHA → 相同 SHA 有缓存则复用 → 否则该SHA读取完整Git tree元数据（拒绝truncated或超过64条目），再获取manifest → Schema 和规模检查 → 顺序读取并校验全部文件 → 一次性发布缓存 → 只提供所请求的允许路径。读取中 dist 更新不影响本次固定 SHA；下一请求重新解析 ref。source_commit 只标识源，不作为缓存版本。上游即使只损坏未请求的一个兄弟产物，整批也不可用。

V1 对私人契约的明确收紧：参考消费者允许1000组且未检查Git mode；Worker额外验证固定提交树的普通文件mode，避免Contents API隐式解引用符号链接；Worker 只接受8组/32文件、总产物8,000,000字节，超限503。未修改原契约；扩容应先评估并升级消费实现，不能削弱验证。每次冷加载最多35个外部请求（ref+tree+manifest+32），热加载1个ref；原生fetch绑定globalThis，redirect=manual且拒绝所有非200状态，避免跟随重定向；不重试，每请求3秒，整批15秒；API JSON流读取上限2,100,000字节（包含Base64与元数据）。目标为Workers Free，不设置付费专用CPU上限；合成8MB测试只证明功能可行，不证明符合免费套餐CPU额度或生产并发容量，超限必须报错而不能跳过完整校验。

模块只缓存一份验证后的字节和SHA，最多8MB有效载荷；JSON/Base64、复制和并发冷加载有额外内存成本，不应视为8MB总内存承诺。没有跨请求共享Promise/Response/流，避免Workers请求上下文I/O错误。缓存隔离到单实例，非持久、不跨实例共享，可能随时丢失。并发冷加载可能重复工作；高并发需在部署侧限流、实测，再考虑上游存储升级。

每次请求重新认证授权并重新解析 dist，不使用TTL内旧ref。新SHA清除旧缓存，整批验证完成才切换。任何刷新失败503，无持久回退；删除路径不从旧快照补齐。并发请求以各自ref解析时刻为版本边界，不能撤回已经在途的下载。当前有效dist本身仍包含的规则，删除源YAML并不自动撤销；紧急撤销必须先通过DEVICE_AUTH禁用。

GitHub 403/429遵守Retry-After（整数秒或HTTP日期，无有效值用60秒），实例内只存退避截止时间并返回503/Retry-After，无自动重试、无旧版响应。其他网络/权限/404/5xx/不兼容也503。health只表示Worker进程可响应，不查询上游或宣称快照就绪。

依据：[GitHub Contents API](https://docs.github.com/en/rest/repos/contents)、[Git tree模式与截断契约](https://docs.github.com/en/rest/git/trees)、[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[当前官方Vitest插件](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)。当前官方推荐@cloudflare/vitest-plugin（替代旧pool包），使用最新相容稳定版本并锁定。Worker源码不导入Node模块、不配置nodejs_compat；测试工具自身的兼容环境不作为生产兼容性证明，另用Wrangler本地启动和打包验证。
