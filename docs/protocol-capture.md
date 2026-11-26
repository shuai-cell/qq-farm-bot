# Helper 协议会话与活动素材索引

网页“协议采集”页面只读 `qq-farm-code-helper-main` 生成的 Helper 会话；不采集 `qq-farm-bot` 自身 WebSocket 流量。

## 页面操作

1. 在 Helper 的“协议模式”生成会话目录。默认读取 `D:\0lishuai\download\protocol-captures\session-1795624137192`，页面也可输入其他 `session-*` 目录。
2. 登录 QQ 农场面板，左侧点“协议采集”→“扫描 Helper 会话”。扫描 `session.json`、`manifest.jsonl`、`connections.jsonl` 和 `*-recv.bin`，不会打开 `handshakes` 目录，因此不会读握手文件里的明文 Code。
3. 页面解码成功响应中的 `ActivityService.List`、`GetGroup` 与公告列表，显示活动 ID、脱敏 JSON、wire 字段摘要、原始 protobuf body SHA-256 以及公告图片地址。活动 body 副本保存在 runtime 的 `protocol-captures/<会话路径哈希>/raw-bodies/`。
4. 活动 JSON 中出现的 URL 可直接进入独立下载流程。Cocos `resource path` 不是 URL；要将其精确映射为 CDN 地址，需提供同版本小程序 `settings.json` 中的 `assets.server`、bundle 名和 `bundleVers`，再用“解析 Cocos manifest”。manifest 精确命中且含 PNG native hash 时才得到 URL；没有对应 manifest 时保留未解析项。
5. 点“下载 HTTPS 素材”后，下载器按活动 ID / 版本 / SHA-256 去重，校验响应类型、大小和内容哈希，并保存到 runtime `protocol-captures/<会话路径哈希>/assets/`。页面显示资源清单及校验状态。

索引文件位于 runtime `protocol-captures/<会话路径哈希>/activity-index.json` 和 `resource-manifest.json`。保留天数、磁盘上限只作用于 bot 本地副本，当前所选会话的索引与 body 保留；Helper 原始会话只读，绝不清理。磁盘预算低于当前会话所需空间时，扫描会提示预算不足。

## 已验证的“以薯换福”会话

`session-1795624137192` 共 174 帧，扫描结果核验：

- `ActivityService.List`：活动组 `2026111707`，子活动 `2026111708`、`2026111709`。
- `ActivityService.GetGroup`：详情包含 `YiShuHuanFuMainUI` 与完整中文规则 JSON。
- `BulletinBoardService.GetBulletinList`：公告“以薯换福”，公告 ID `26112401`，图片 URL `https://cdn-resource.nqf.qq.com/uploads/gengxingonggao_bn.png`。

因此页面“素材为空”的一部分原因已修复：公告图片从 Bulletins 响应提取，而非仅从活动 GetGroup body 寻找 URL。GetGroup 提供的活动规则文本尚不含活动内图片的 Cocos 资源路径；页面可以显示资源引用，但补齐活动内图标/背景需匹配该小程序版本的 Cocos manifest。牧歌资产清单不会用于猜测以薯换福的资源。

本次功能仍是 Helper 会话扫描、活动详情解码、公告素材下载及路径映射工具；“以薯换福”的后端玩法服务和前端交互尚未实现。
