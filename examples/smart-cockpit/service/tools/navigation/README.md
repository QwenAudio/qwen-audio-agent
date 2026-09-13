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

### 按记忆推荐附近餐厅

饮食偏好继续由前台的通用 `memory` 工具保存和恢复；座舱不另建推荐或记忆系统。
`navigation_search_place` 的工具描述指导模型将菜系、食物类别用于搜索，将辣度等要求
留作推荐时的核实条件。例如已记住“喜欢烧烤，不太能吃辣”，后续询问附近合口味的
餐厅时搜索“烧烤”，而不是把“烧烤 不辣”视为店名。

结果只来自真实 POI，保留店名、地址、距离等可用信息；无结果不通过地理编码制造
一个以查询词命名的地点，也不把周边搜索悄悄放宽到全市。模型可以简化关键词再查
一次；仍无结果就据实说明。地图结果没有菜单、辣度或过敏原依据，不能保证商家
满足这些要求。搜索和推荐不开始导航，用户选定并明确要求前往后才导航。

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

主地图空闲态保留地图、定位和路线偏好控件，不常驻目的地搜索栏或“回家/去公司”快捷行。地点搜索、常用地点设置和导航通过语音工具完成；不展示快捷行不会清除已保存地点。具体 marker 不常驻地图，只在用户查看常用地点或导航到该地点时强调。

## 调用原则

- 前台直接执行路线规划或重规划、且意图明确和信息齐全时，调用前用一句简短自然口语说明本次规划动作，随后在同一轮立即调用工具；规划过程中可以按需说明地点和顺序，不等待再次确认，同一请求只作一次开场衔接。缺少必要信息时仍先追问；快速本地操作和只读当前路线不强加前置回应，后台任务仍在受理后衔接。
- 新路线规划（包括预览）或重规划成功后，工具文本只返回总里程和预计耗时，例如“全程36.9公里，约75分钟”，不包含目的地或途经点。完整路线、导航/预览状态仍保留在 `data.navigation`（MCP 的 `structuredContent.navigation`）及状态/进度事件中，地图展示不变。
- 座舱工具 description 同时约束最终语音只报里程和耗时，不从结构化数据补读地点。用户主动询问路线详情时仍可展开：不带目的地的 `navigation_route_query` 返回完整当前路线，失败或未完成仍如实说明。前台直调和后台结果播报使用相同原则，不固定话术，不修改通用系统 Prompt 或协议。
- 高德驾车路线请求在 Service 进程内统一保持至少 600ms 的发起间隔（包含重试），避免多途经点连续查询触发 QPS 限流；首次请求不额外等待，其他地图能力不进入此队列。
- 用户给新目的地时，调用 `navigation_start` 或 `navigation_route_query`。
- 用户在已有导航中修改路线时，调用 `navigation_add_waypoint`、`navigation_remove_waypoint`、`navigation_change_destination` 或 `navigation_set_route_strategy`。
- 用户只是找地点时，调用 `navigation_search_place`。
- 常用地点导航使用 `navigation_to_favorite`，设置常用地点使用 `navigation_set_favorite`。
- 导航语音和视图设置不要混入路线工具，分别使用 `navigation_set_voice` 和 `navigation_set_view`。
- 高德 MCP 基础能力由服务层编排，不直接暴露给模型。
- 不按话术或固定参数拆工具；话术写入 description/examples，固定值做成枚举参数。
