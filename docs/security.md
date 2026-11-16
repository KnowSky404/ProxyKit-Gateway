# 安全边界

GITHUB_READ_TOKEN只允许固定私人仓库Contents: Read，与设备凭据完全独立。Provider固定api.github.com/KnowSky404/ProxyKit-Private，ref只发现dist，读取固定SHA与Manifest白名单。客户端无法指定仓库、Git ref、内部路径或URL；先检查同一SHA下Manifest与目标文件的Git tree普通文件mode，拒绝Contents API解引用的符号链接；树元数据最多4064条目，truncated直接拒绝。不请求临时download_url，禁止重定向，避免SSRF及凭据被带往别处。

DEVICE_AUTH是一个Secret JSON：

```json
{
  "devices": [
    {
      "id": "phone-header",
      "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_SHA256",
      "transport": "bearer",
      "enabled": true,
      "paths": ["*"]
    }
  ],
  "disabled_paths": []
}
```

占位摘要不是有效配置。每设备由本地脚本生成32随机字节、43字符Base64URL Token；Worker只保存其SHA-256和授权。摘要比较使用Workers原生crypto.subtle.timingSafeEqual的固定32字节输入。验证所有设备后决定匹配；不明文比较Token。不缓存身份配置：每次请求重新读取当前绑定，检查enabled、transport、设备范围及disabled_paths。`paths: ["*"]` 显式授权固定仓库内全部当前及未来的已验证产物；基本路由和固定 Provider 仍限制仓库、分支及可下载文件，不能读取任意 GitHub 路径。其他设备配置只接受最多32个精确路径，空数组仍拒绝全部路径；不支持目录通配或将 `*` 与精确路径混用。已有设备不会自动扩大权限；切换仓库范围需要显式更新其 Secret。`disabled_paths` 始终只接受精确路径，仓库范围设备同样遵守停用、撤销和每次请求鉴权。配置按UTF-8计最多5000字节（遵守Cloudflare单个Secret 5KB上限）；设备数同时受配置总大小约束，解析器另限制最多64条设备记录；id/摘要唯一，字段严格匹配，重复键拒绝。

客户端目录同样先执行设备认证。仓库范围设备可以列出对应客户端的资源，精确路径设备须在该客户端下至少有一个授权文件路径；仅在响应中保留授权且未停用的条目。空路径列表或仅有其他客户端授权时403，授权资源全部不可见时返回空列表。过滤后的JSON才生成ETag并处理304，权限变化不得复用旧的跨设备列表。列表路径不携带或回显KEY，未认证时不暴露名称、ETag或版本。

enabled=false或移除摘要使设备401；disabled_paths在已认证且已授权后410。轮换可先添加新的独立id/摘要，再切换设备，最后删除旧条目。紧急撤销直接删除/禁用并100%部署新的Secret版本；部署传播和已在途请求存在平台边界，不允许渐进部署旧认证版本后声称全球立即撤销。客户端已下载的规则无法远程销毁。

URL Token默认禁用，仅作Loon/QX待验收的兼容方案，必须与Bearer使用不同设备Token。URL会进入客户端备份/同步、截图、历史、反向代理、运营商或平台元数据记录；TLS不消除这些端点风险。泄漏后撤销对应设备摘要、生成新的URL专用Token并替换订阅。不要将URL Token放在公开Issue、分享配置或分析服务中。

Worker仅记录固定错误类别、状态与随机requestId；不记录原始异常、URL/query、Header、设备信息、正文或GitHub响应。cloudflare.config.ts显式redactQueryString=true、invocationLogs=false、traces.enabled=false（为满足URL凭据边界，优先于通用trace默认值）；保留脱敏应用错误日志。不启用Logpush、Tail或第三方追踪。平台网络层、客户端和本地开发服务器请求日志不受应用日志代码控制，部署前审计整条链路；实际隐私验证未覆盖Cloudflare生产。参考[观测配置](https://developers.cloudflare.com/workers/wrangler/configuration/#observability)。

私人资源在入口强制HTTPS（HTTP返回400且不读取上游）；health可通过HTTP用于本地检查。响应永远private,no-store，Cloudflare Cache API不保存私有响应。每次304或内存命中都重新鉴权。部署域名必须配置绕过Cache Rules/CDN共享缓存，不得用Cache Everything覆盖响应，也不得在Worker前加绕过鉴权的缓存。不要记录带Cookie/Token/完整URL的缓存键；当前元数据缓存按不可变dist SHA区分，字节缓存额外绑定目标路径，只保留最近一个文件。

上游响应流与文件大小都有硬上限；只在所请求文件的全部字节通过声明大小和摘要验证后返回。其他产物正文不预取、不校验，不因其损坏而阻断当前目标；全局 Manifest 和目标文件校验保持严格。GitHub TLS和受信任发布者仍是信任边界：Manifest摘要防损坏/混读，不是独立签名，无法防御同时篡改Manifest与产物的仓库写入者。不执行产物代码，不编译或反序列化SRS。

公开CI无生产Secrets，禁pull_request_target，Actions固定完整SHA，contents:read，依赖锁定并审计，不上传私人数据Artifact。部署只main显式手动触发，production环境建议配置必需审批。无法防御有权修改代码/Secrets/Cloudflare配置的维护者。本次不擅自新增分支保护或仓库设置；实际门禁状态以GitHub为准。

未增加应用层分布式限流：非法请求不会访问GitHub，但大量合法请求会消耗每次ref查询和配额。上线前按账户能力配置不记录凭据的速率限制；并发和CPU以生产压测为准。V1无持久旧版回退，GitHub不可用时牺牲可用性返回503。
