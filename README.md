# F1 赛后数据

按赛季、分站和会话节点查看赛后数据。排位赛可以展开到 Q1、Q2、Q3；“年度排名”单独展示官网排名快照；“实时推送”按相同的赛季、分站、节点架构读取最新数据。车手、车队和结果字段统一转换为后台字段。

## 统一字段映射

`backend-fields.mjs` 是赛程管理和实时推送共用的转换模块。每个会话响应都会提供 `mapped`：

- 基础字段：`winner`、`competitors`、`fields`，包括后台车手 ID、后台车队 ID、车号、名次、圈数、状态、时间、间距、进站次数、最快圈、积分和 NC 描述。
- 扩展字段：`extra.weather`、`last_lap_time`、`last_lap_time_color`、`best_lap_time_color`、`sectors`、`mini_sectors_data`、`tire_info`、`tire_history`、`track_limits`。
- 赛会消息：`messages`，统一为 `lap`、`text_en`、`text_zh`、`utc`。

车手和车队 ID 使用后台映射表，计时、轮胎、天气和赛会消息由数据源字段转换；NC 仅在正赛和冲刺赛按冠军实际圈数的 90% 向下取整计算。

## 本地运行

需要 Node.js 20 或更高版本：

```bash
npm start
```

打开 `http://127.0.0.1:4173/`，在登录页输入本地配置的账户信息。

## GitHub Pages

仓库内的 `.github/workflows/pages.yml` 会发布仓库根目录。根目录静态入口与 `site/` 本地服务入口保持同步；发布后的页面在浏览器中直接读取数据源，并将每个会话的完整响应保存到 IndexedDB；点击“同步数据源”会强制重新拉取，失败时不会覆盖已有缓存。

GitHub Pages 的登录是前端入口校验，适合私有仓库或内部使用；需要服务端安全和真正的账户隔离时，请运行本地 Node 服务或部署 `server.mjs` 到支持 Node 的服务。

年度排名快照由 `.github/workflows/sync-official-standings.yml` 每周一北京时间 08:00 自动更新，也可以在 GitHub Actions 中手动运行该工作流。页面里的“人工同步”会重新读取当前已发布的快照；本地 Node 服务还支持直接从官网刷新快照。
