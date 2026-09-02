# F1 赛后数据

按赛季、分站和会话节点查看赛后数据。排位赛可以展开到 Q1、Q2、Q3；“年度排名”单独展示官网排名快照；“实时推送”按相同的赛季、分站、节点架构读取最新数据。车手、车队和结果字段统一转换为后台字段。

## 统一字段映射

`backend-fields.mjs` 是赛程管理和实时推送共用的转换模块。每个会话响应都会提供 `mapped`：

- 基础字段：`winner`、`competitors`、`fields`，严格使用后台字段名 `_id`、`teamuid`、`car_number`、`position`、`laps`、`status`、`time`、`interval`、`gap_to_leader`、`pitstop_count`、`fastest_lap_time`、`points` 和 `position_desc`。
- 扩展字段：`extra.weather`、`last_lap_time`、`last_lap_time_color`、`best_lap_time_color`、`sectors`、`mini_sectors_data`、`tire_info`、`tire_history`、`track_limits`。
- 赛会消息：`messages`，统一为 `lap`、`text_en`、`text_zh`、`utc`。

车手和车队 ID 使用后台映射表；数据源字段只在转换层使用，页面和 `mapped` 响应不暴露 `id`、`team_id`、`pitstop` 等数据源命名。NC 仅在正赛和冲刺赛按冠军实际圈数的 90% 向下取整计算。

## 本地运行

需要 Node.js 20 或更高版本：

```bash
npm start
```

打开 `http://127.0.0.1:4173/`，在登录页输入本地配置的账户信息。

## GitHub Pages

### nana 实时入口

登录 Node 服务后访问 `/api/live-timing/entry`，会返回一组带令牌的入口地址。把其中的 `ingest.url` 交给另一套后台，它用 `POST` 逐条推送实时数据；本站的“实时推送”选择数据源 `nana` 并点击“开始实时”后，会通过 SSE 自动接收当前状态。同一赛事按 `id` 在内存中增量更新：本次携带的普通字段覆盖旧值，车手按 `id` 或车号合并，消息去重追加，扩展字段按车手 ID 覆盖；赛事 `id` 变化时才清空上一场。实时数据只保存在内存，不写入历史文件。

推送请求也可以把令牌放在 `X-Live-Timing-Token` 请求头中，地址使用 `/api/live-timing/ingest`。请求体支持标准 JSON、`{ "data": <数据> }`、直接发送“日志前缀 + Python 字典”的原始 TXT，或用 `multipart/form-data` 上传该文件；没有 `session`、`meeting`、`mapped` 等前置字段要求。另一后台已经生成的 `winner`、`competitors`、`fields`、`messages`、`extra` 会按原字段和值保存，页面只做读取适配，不再次经过 OpenF1 转换。`/api/live-timing` 返回当前状态，`/api/live-timing/stream` 提供持续 SSE 数据流。

GitHub Pages 只能托管静态页面，不能接收这个 POST 入口。需要把 `server.mjs` 部署到公网 Node 主机，并设置 `F1_HOST=0.0.0.0` 与随机的 `LIVE_TIMING_BRIDGE_TOKEN`。服务会优先读取云平台提供的 `PORT`，同时兼容 `F1_PORT`。

公网部署还应在平台的环境变量中设置 `F1_AUTH_USERNAME` 和 `F1_AUTH_PASSWORD`，不要把登录凭据写入仓库。

仓库内的 `.github/workflows/pages.yml` 会发布仓库根目录。根目录静态入口与 `site/` 本地服务入口保持同步；发布后的页面在浏览器中直接读取数据源，并将每个会话的完整响应保存到 IndexedDB；点击“同步数据源”会强制重新拉取，失败时不会覆盖已有缓存。

GitHub Pages 的登录是前端入口校验，适合私有仓库或内部使用；需要服务端安全和真正的账户隔离时，请运行本地 Node 服务或部署 `server.mjs` 到支持 Node 的服务。

年度排名快照由 `.github/workflows/sync-official-standings.yml` 每周一北京时间 08:00 自动更新，也可以在 GitHub Actions 中手动运行该工作流。页面里的“人工同步”会重新读取当前已发布的快照；本地 Node 服务还支持直接从官网刷新快照。
