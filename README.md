# baby-outfit-wxbot

公众号收图服务：别人在公众号里发「1」开始 → 按顺序发衣服图 → 可以发文字备注 → 发「2」提交。
Mac 定时运行 `sync/sync.py`，把已提交的组存到 `宝宝穿搭/<日期>_公众号_<批次>/原图/01.jpg…` 并弹出通知，之后交给 `baby-outfit-xhs` skill 处理。

## 组成

- `index.js`：微信云托管服务（Node 20，无依赖）。`/wx/message` 接收消息推送（JSON 格式），`/api/*` 给 Mac 拉取用（请求头要带 `x-sync-token`）。
- `sync/sync.py`：Mac 端拉取脚本，配置在 `~/.config/baby-outfit-wxbot/.env`（`BASE_URL`、`SYNC_TOKEN`）。

## 部署（微信云托管）

- 服务 `wxbot` 绑定本仓库的 `main` 分支，端口 80，推送后自动部署。
- 最大实例数设为 1：状态在内存里汇总，只能有一个实例。
- 环境变量里配 `SYNC_TOKEN`。
- 开启开放接口服务，白名单加上 `/tcb/uploadfile` 和 `/tcb/batchdownloadfile`。
- 消息推送：公众号，路径 `/wx/message`，格式 JSON。

## 本地测试

```bash
STORAGE=local LOCAL_DIR=./data PORT=8766 SYNC_TOKEN=tok node index.js
```

## 已知限制

- 未认证的订阅号只能被动回复，成品不会自动回给发图的人。
- 服务闲置后第一条消息要冷启动；微信会自动重试，服务端按 MsgId 去重。
- 没发「1」就直接发图，会自动开一组。
