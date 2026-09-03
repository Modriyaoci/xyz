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

打开 `http://127.0.0.1:4174/`，在登录页输入本地配置的账户信息。

### FastF1 独立数据源

赛程管理中的“数据源”选择器可以在 OpenF1 和 FastF1 之间切换。两套源各自使用自己的赛历、节点和会话数据，完全独立，不合并、不互相兜底；FastF1 可读取 2018–最新赛季（具体以 FastF1 可用数据为准），OpenF1 仍按自己的覆盖范围工作。FastF1 会话响应包含赛果、圈速、进站、轮胎、天气和赛会消息，并在转换层统一为后台字段。首次使用本地 FastF1 源需要安装 Python 依赖：

```bash
python3 -m venv work/fastf1-venv
work/fastf1-venv/bin/python -m pip install -r requirements.txt
```

`FASTF1_PYTHON` 可指定其他 Python 路径，`FASTF1_ENABLED=0` 可关闭本地 FastF1 源（兼容旧变量 `FASTF1_FALLBACK=0`）。FastF1 原始缓存保存在 `work/fastf1_cache/`，不会发布到网站。

FastF1 的赛历目录由 `scripts/fastf1-catalog.py` 生成并保存在 `fastf1-meetings.json`；会话数据按选择节点实时读取并缓存到 `work/fastf1_session_cache/`。静态 GitHub Pages 不能运行 Python，目前只提供 FastF1 目录；要读取 FastF1 会话请使用本地 Node 服务，不能回退到 OpenF1：

```bash
work/fastf1-venv/bin/python scripts/fastf1-catalog.py --start 2018 --end 2026 --output fastf1-meetings.json
cp fastf1-meetings.json site/fastf1-meetings.json
```

### nana 实时入口

登录本地 Node 服务后访问 `/api/live-timing/entry`，会返回一组带令牌的入口地址。把其中的 `ingest.url` 交给另一套后台，它用 `POST` 逐条推送实时数据；Node 页面打开后默认连接 `nana`，通过 SSE 自动接收当前状态。同一赛事按 `id` 在内存中增量更新：本次明确推送的字段覆盖旧值，未推送的字段保持不变；空数组不会清空旧记录，有标识的数组按记录合并，没有标识的数组按位置更新并保留未推送的尾部，消息按消息标识去重追加。只有赛事 `id` 变化时才会开始一份新的实时状态。实时状态不保存历史快照；另有一份最新原始 longtext 会原子替换保存，可通过入口返回的 `raw.url` 读取。

`raw.url` 仅用于排查数据源问题，返回的是解析前的原始文本（JSON 或日志前缀 + Python 字典），令牌无效时不可读取。Render 免费实例的文件系统是临时的，服务重启或重新部署后这份诊断文件可能消失；它不会随着推送次数增长。

推送请求也可以把令牌放在 `X-Live-Timing-Token` 请求头中，地址使用 `/api/live-timing/ingest`。请求体支持标准 JSON 快照、`{ "data": <快照> }`、直接发送“日志前缀 + Python 字典”的文本文件，或用 `multipart/form-data` 上传该文件；没有 `session`、`meeting`、`mapped` 等前置字段要求。另一后台已经生成的 `winner`、`competitors`、`fields`、`messages`、`extra` 会按原字段和值保存，页面只做读取适配，不再次经过 OpenF1 转换。`/api/live-timing` 返回当前快照，`/api/live-timing/stream` 提供持续 SSE 数据流。

GitHub Pages 是静态托管，不能接收这个 POST 入口；要把入口交给外部后台，必须把 `server.mjs` 部署到一个可从外网访问的 Node 服务。公网部署时将 `F1_HOST=0.0.0.0`，并用平台分配的域名访问 `/api/live-timing/ingest`；`F1_PORT` 可由平台端口环境变量覆盖。建议同时设置随机的 `LIVE_TIMING_BRIDGE_TOKEN`，不要使用默认令牌。

公网部署还应在平台的环境变量中设置 `F1_AUTH_USERNAME` 和 `F1_AUTH_PASSWORD`，不要使用本地默认登录密码；云平台通常会自动提供 `PORT`，服务会优先读取它。

Render 环境会自动禁用 OpenF1 和 FastF1 会话磁盘缓存，每次选择节点都从对应数据源重新获取。FastF1 原始文件只在单次转换期间临时存在，完成或失败后都会清理；本地 Node 服务仍保留原有缓存行为。

## GitHub Pages

仓库内的 `.github/workflows/pages.yml` 会发布仓库根目录。根目录静态入口与 `site/` 本地服务入口保持同步；发布后的页面在浏览器中直接读取数据源，并将每个会话的完整响应保存到 IndexedDB；点击“同步数据源”会强制重新拉取，失败时不会覆盖已有缓存。

GitHub Pages 的登录是前端入口校验，适合私有仓库或内部使用；需要服务端安全和真正的账户隔离时，请运行本地 Node 服务或部署 `server.mjs` 到支持 Node 的服务。

年度排名快照由 `.github/workflows/sync-official-standings.yml` 每周一北京时间 08:00 自动更新，也可以在 GitHub Actions 中手动运行该工作流。页面里的“人工同步”会重新读取当前已发布的快照；本地 Node 服务还支持直接从官网刷新快照。
