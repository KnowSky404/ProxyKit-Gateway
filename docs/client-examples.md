# 客户端配置与验证边界

以下全部使用保留域名与占位Token。已核对官方文档/官方示例中的订阅结构；没有真实iOS设备或已部署网关，Loon/QX/sing-box实际更新、HEAD/304处理、网络、策略及DNS效果均待真机验证。不要将自动HTTP测试通过描述为客户端验收通过。

## Loon

[官方示例](https://github.com/Loon0x00/LoonExampleConfig/blob/master/example.conf)使用`[Remote Rule]`中的URL、policy和enabled：

```ini
[Remote Rule]
https://gateway.example.com/v1/private/loon/example.list?key=DEVICE_URL_TOKEN_PLACEHOLDER,policy=PROXY,enabled=true
```

现有官方示例未列出此订阅项自定义Authorization Header能力，因此不声称其支持或不支持；优先在具体安装版本确认。如果无法可靠设Header，启用网关URL兼容模式并生成仅transport=url的独立设备Token。规则内no-resolve及主配置DNS行为仍由原规则契约负责。

## Quantumult X

[官方sample.conf](https://github.com/crossutility/Quantumult-X/blob/master/sample.conf)提供filter_remote及force-policy字段：

```ini
[filter_remote]
https://gateway.example.com/v1/private/quantumultx/example.list?key=DEVICE_URL_TOKEN_PLACEHOLDER, tag=PrivateExample, force-policy=PROXY, enabled=true
```

官方示例未提供此下载条目的可靠自定义Authorization配置；这不是“不支持Header”的实测结论。URL兼容模式与Loon同样需显式启用和独立Token。force-policy应替换为用户已有策略名；QX历史规则第三字段不是DNS开关，不宣称与Loon no-resolve无条件等价。

## sing-box

[规则集文档](https://sing-box.sagernet.org/configuration/rule-set/)和[HTTP Client文档](https://sing-box.sagernet.org/configuration/shared/http-client/)说明1.14.0起的http_client和headers。使用1.14+配置片段（插入已有route.rule_set）：

```json
{
  "route": {
    "rule_set": [
      {
        "type": "remote",
        "tag": "private-example",
        "format": "binary",
        "url": "https://gateway.example.com/v1/private/sing-box/example.srs",
        "http_client": {
          "headers": { "Authorization": "Bearer DEVICE_TOKEN_PLACEHOLDER" }
        },
        "update_interval": "1h"
      }
    ]
  }
}
```

JSON模式将format改为source、URL后缀改为.json，并单独授予该精确路径。Manifest的minimum_reader限制实际客户端最低版本；目前发布工具链使用source_format=2和最低1.10.0，但上述Header下载配置需要1.14+，不能套到旧版本。旧版下载鉴权需按其官方版本能力另行验证，不能虚构Header支持。

不要自动添加策略、DNS预解析或download_detour；它们属于用户已有主配置。CIDR如依赖require-no-pre-resolution须维持该前提。Gateway只原样分发已构建字节。

## 验收清单

每种实际安装版本记录：版本号、首次获取、定时更新、Header/URL实际方式、HEAD/ETag/304行为、更新后摘要、错误Token401、权限不足403、撤销401、停用410、上游503时客户端是否仍使用本地旧副本。客户端本地旧副本无法由网关保证销毁。测试结果必须脱敏，不贴完整订阅URL。
