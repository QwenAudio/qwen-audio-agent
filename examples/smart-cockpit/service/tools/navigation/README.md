# Navigation tool design

本文记录 smart-cockpit 示例中的导航 function call 设计。

## 设计定位

导航工具保持车机业务工具粒度，而不是把高德 MCP 的 `maps_*` 基础能力直接暴露给模型。

设计分层：

- 模型可见工具：表达用户意图和车机导航动作，例如开始导航、查询路线、增加途经点、修改路线偏好。
- 服务层能力：编排高德 MCP / 高德 Web API，例如地点搜索、地理编码、周边搜索、驾车路线规划。
- 状态层：维护当前导航状态、目的地、途经点、常用地点、路线、地图 marker/polyline、语音和视图设置。

路线起点、“当前位置”收藏和 `vehicle_location_query` 共用
`service/vehicle-location.mjs` 的定位结果。默认位置只是 Demo 回退；接入
车机 GPS 时通过 Cockpit Service 的 `services.vehicleLocation()` 替换。

这样可以减少模型在低层地图 API 之间的选择负担，同时保留车机场景需要的运行态控制。

## 工具大类

| 大类 | 工具 | 目标 |
| --- | --- | --- |
| 路线生命周期 | `navigation_start`, `navigation_route_query`, `navigation_stop` | 开始导航、查询/预览路线、停止导航 |
| 导航中修改 | `navigation_add_waypoint`, `navigation_remove_waypoint`, `navigation_change_destination`, `navigation_set_route_strategy` | 在当前路线基础上加点、删点、改终点、改偏好 |
| 地点/POI 查询 | `navigation_search_place` | 搜索地点或附近 POI，但不开始导航 |
| 常用地点 | `navigation_to_favorite`, `navigation_set_favorite` | 导航到家/公司/学校等常用地点，或设置常用地点 |
| 呈现/播报 | `navigation_set_voice`, `navigation_set_view` | 设置导航静音、播报模式和地图视图 |

## Function call 表

| Function | 什么时候调用 | 关键参数 | 状态影响 | 内部对应高德能力 |
| --- | --- | --- | --- | --- |
| `navigation_start` | 用户明确说“导航到”“带我去”“去某地”或“开始导航” | `destination`, `waypoints?`, `strategy?` | `status=navigating`，写入目的地、途经点和路线 | `maps_text_search` / `maps_search_detail` / `maps_geo` + 驾车路线 |
| `navigation_route_query` | 用户只想看路线、多久、多远、怎么走、先看看路线 | `destination?`, `waypoints?`, `strategy?` | 有目的地时 `status=preview`；无目的地时只读当前路线 | 有目的地时同上；无目的地时不调用高德 |
| `navigation_stop` | 停止、退出、取消导航 | 无 | `status=idle`，清空目的地、途经点、路线和地图图层 | 本地状态操作 |
| `navigation_add_waypoint` | “中途去一下”“顺路去”“加个途经点”“先去一下” | `waypoint`, `insertPosition?`, `strategy?` | 保持当前 `status`，插入途经点并重新规划 | 地点解析 + 驾车路线 |
| `navigation_remove_waypoint` | “取消途经点”“不去刚才那个地方了”“删掉第几个途经点” | `waypoint?`, `index?` | 保持当前 `status`，删除途经点并重新规划 | 本地状态 + 驾车路线 |
| `navigation_change_destination` | “目的地改成”“换个地方”“不去那里了去这里” | `destination`, `strategy?` | 保持当前 `status`，改最终目的地并重新规划 | 地点解析 + 驾车路线 |
| `navigation_set_route_strategy` | “换成不走高速”“改成少收费”“避开拥堵” | `strategy` | 有路线时重新规划；无路线时作为后续导航的默认偏好 | 本地状态 + 必要时的驾车路线 |
| `navigation_search_place` | “附近有没有充电站”“找个加油站”，但没有要求导航 | `query?`, `category?`, `nearby?`, `radius?` | 不修改导航状态 | `maps_text_search` / `maps_around_search` / `maps_search_detail` |
| `navigation_to_favorite` | “回家”“去公司”“去学校” | `favoriteType`, `strategy?` | `status=navigating`，基于常用地点开始导航 | 读取本地收藏地址 + 驾车路线 |
| `navigation_set_favorite` | “把这里设为家”“设置公司地址”“把某地设为学校” | `favoriteType`, `address?`, `useCurrentLocation?` | 更新 `navigation.favorites` | 地点解析或当前位置 |
| `navigation_set_voice` | “导航静音”“取消静音”“详细播报”“简洁播报” | `mute?`, `broadcastMode?` | 更新 `navigation.voice` | 本地状态操作 |
| `navigation_set_view` | “查看全程”“回到车头视角”“切到全览” | `viewMode` | 更新 `navigation.viewMode` | 本地状态操作 |

## 路线偏好

`strategy` 同时用于新路线和当前路线重规划：

- 用户给新目的地时，作为 `navigation_start` 或 `navigation_route_query` 参数。
- 用户只要求修改当前路线偏好时，调用 `navigation_set_route_strategy`。

| 值 | 含义 |
| --- | --- |
| `0` | 智能推荐 |
| `13` | 高速优先 |
| `5` | 不走高速 |
| `4` | 躲避拥堵 |
| `11` | 少收费 |
| `14` | 大路优先 |
| `2` | 时间优先 |

示例：

| 用户话术 | 推荐调用 |
| --- | --- |
| “导航去机场，别走高速” | `navigation_start({ destination: "机场", strategy: 5 })` |
| “查一下去西湖最快路线” | `navigation_route_query({ destination: "西湖", strategy: 2 })` |
| “换成少收费路线” | `navigation_set_route_strategy({ strategy: 11 })` |
| “改成高速优先去上海” | `navigation_start({ destination: "上海", strategy: 13 })` |

## 高德 MCP 对应关系

路线类工具是业务编排工具，内部大致链路：

1. 通过 `maps_text_search` 搜索 POI。
2. 必要时用 `maps_search_detail` 查询 POI 详情。
3. 搜索失败时用 `maps_geo` 做地址到坐标的兜底解析。
4. 调用驾车路线能力规划路线。当前代码直接请求高德驾车路线 Web API，语义上对应 `maps_direction_driving`。
5. 将路线结果写入本地 `navigation` 状态，并更新地图 marker/polyline。

地点查询类工具：

- 普通地点搜索使用 `maps_text_search`。
- 周边搜索使用 `maps_around_search`。
- 需要补全 POI 坐标时使用 `maps_search_detail`。

本地控制类工具不对应高德 MCP：

- `navigation_stop`
- `navigation_set_voice`
- `navigation_set_view`

## 常用地点展示

常用地点状态服务于导航和 UI 展示，推荐保存为 `{ label, name, address, location }`：

- `label` 是用户可识别的类型，例如“家”“公司”。
- `name` 是设置时使用的地点名或 POI 名。
- `address` 是 UI 副标题，缺省时可回退到 `name`。
- `location` 是路线规划使用的经纬度。

主地图空闲态显示目的地搜索面板：顶部是“搜索目的地”入口，下方是“回家/去公司”快捷行。未设置时显示“点击设置”，已设置时显示地点信息和导航入口。具体 marker 不常驻地图，只在用户查看常用地点或导航到该地点时强调。

## 调用原则

- 用户给新目的地时，调用 `navigation_start` 或 `navigation_route_query`。
- 用户在已有导航中修改路线时，调用 `navigation_add_waypoint`、`navigation_remove_waypoint`、`navigation_change_destination` 或 `navigation_set_route_strategy`。
- 用户只是找地点时，调用 `navigation_search_place`。
- 常用地点导航使用 `navigation_to_favorite`，设置常用地点使用 `navigation_set_favorite`。
- 导航语音和视图设置不要混入路线工具，分别使用 `navigation_set_voice` 和 `navigation_set_view`。
- 高德 MCP 基础能力由服务层编排，不直接暴露给模型。
- 不按话术或固定参数拆工具；话术写入 description/examples，固定值做成枚举参数。
