# Vehicle tool design

本文记录 smart-cockpit 示例中的车控 function call 设计。参考 Tesla Fleet API 的车辆状态与车辆命令划分，但工具粒度保持本项目的车机业务语义，而不是逐个暴露 Tesla endpoint 或参考表中的 atomic function。

## 设计定位

车控工具保持“状态查询独立、控制按能力域聚合”的粒度。

设计分层：

- 模型可见工具：表达用户意图和车机控制动作，例如查询车况、调节空调、控制车窗、开启座椅加热、打开充电口。
- 服务层能力：把业务工具参数映射到底层车辆 API、模拟状态或厂商 SDK，例如 Tesla Fleet API / 参考 atomic API。
- 状态层：维护当前车辆状态、空调温度、车窗/天窗/开闭件、舒适配置、灯光/声音、充电状态等。

这样可以减少模型在大量底层原子 API 之间的选择负担，同时保留车控场景需要的完整 scope。

## 工具大类

| 大类 | 工具 | 目标 |
| --- | --- | --- |
| 状态查询 | `vehicle_state_query` | 查询车辆当前状态，不改变车辆 |
| 空调/座舱温控 | `vehicle_climate_control`, `vehicle_temperature_control` | 开关空调预处理、设置座舱温度 |
| 座椅/方向盘舒适控制 | `vehicle_comfort_control` | 座椅加热/通风/自动座椅温控、方向盘加热 |
| 车窗/天窗/开闭件 | `vehicle_window_control`, `vehicle_sunroof_control`, `vehicle_closure_control` | 控制车窗、天窗、前/后备箱、充电口 |
| 灯光/声音/定位提示 | `vehicle_light_control`, `vehicle_sound_control` | 闪灯、鸣笛、外放定位提示音 |
| 充电控制 | `vehicle_charging_control` | 开始/停止充电、设置充电上限/电流、管理充电计划 |

## Function call 表

| Function | 什么时候调用 | 关键参数 | 状态影响 | 内部对应能力 |
| --- | --- | --- | --- | --- |
| `vehicle_state_query` | 用户问“当前状态”“空调多少度”“车窗开了吗”“还在充电吗”等 | `part?` | 只读 | Tesla `vehicle_data` / 本地车辆状态 |
| `vehicle_climate_control` | 用户要打开/关闭空调、开启预处理、关闭预处理 | `action` | 更新 climate 开关/预处理状态 | Tesla `auto_conditioning_start`, `auto_conditioning_stop` |
| `vehicle_temperature_control` | 用户要把温度调到某值，或调高/调低温度 | `zone?`, `action`, `temperature?`, `delta?` | 更新座舱温度 | Tesla `set_temps` |
| `vehicle_comfort_control` | 用户要控制座椅加热、座椅通风/制冷、自动座椅温控、方向盘加热 | `target`, `seat?`, `action`, `level?`, `enabled?` | 更新座椅/方向盘舒适状态 | Tesla seat / steering wheel climate commands |
| `vehicle_window_control` | 用户要通风、关闭车窗、打开/关闭某个车窗或全车车窗 | `action`, `window?`, `level?` | 更新车窗状态 | Tesla `window_control` |
| `vehicle_sunroof_control` | 用户要关闭天窗、打开通风/翘起、停止天窗动作 | `action`, `position?` | 更新天窗状态 | Tesla `sun_roof_control` |
| `vehicle_closure_control` | 用户要打开/关闭前备箱、后备箱、尾门、充电口/加油口 | `target`, `action` | 更新开闭件状态 | Tesla `actuate_trunk`, `charge_port_door_open`, `charge_port_door_close` |
| `vehicle_light_control` | 用户要闪灯、打开/关闭灯光或通过灯光找车 | `action`, `light?` | 更新灯光或触发一次性动作 | Tesla `flash_lights` |
| `vehicle_sound_control` | 用户要鸣笛、播放外部提示音、通过声音找车 | `action`, `soundId?` | 触发一次性声音动作 | Tesla `honk_horn`, `remote_boombox` |
| `vehicle_charging_control` | 用户要开始/停止充电，设置充电上限、电流，或管理充电计划 | `action`, `limitPercent?`, `amps?`, `schedule?`, `scheduleId?` | 更新充电状态/设置/计划 | Tesla charging commands |

## Tesla 参考范围

本设计只取以下 Tesla Fleet API 车控相关能力作为参考，不包含导航、媒体播放、日历、电话、驾驶授权、访客/家长/限速模式、OTA、车辆命名等非本轮车控 scope。

### 状态/唤醒

| Tesla function | 用途 | 建议映射 |
| --- | --- | --- |
| `vehicle_data` | 实时读取车辆状态数据 | `vehicle_state_query` |

### 空调/座舱温控

| Tesla function | 用途 | 建议映射 |
| --- | --- | --- |
| `auto_conditioning_start` | 开启空调预处理 | `vehicle_climate_control` |
| `auto_conditioning_stop` | 关闭空调预处理 | `vehicle_climate_control` |
| `set_temps` | 设置主驾/副驾等座舱温度 | `vehicle_temperature_control` |

### 座椅/方向盘舒适控制

| Tesla function | 用途 | 建议映射 |
| --- | --- | --- |
| `remote_seat_heater_request` | 设置座椅加热 | `vehicle_comfort_control` |
| `remote_seat_cooler_request` | 设置座椅制冷/通风 | `vehicle_comfort_control` |
| `remote_auto_seat_climate_request` | 设置自动座椅温控 | `vehicle_comfort_control` |
| `remote_steering_wheel_heater_request` | 开关方向盘加热 | `vehicle_comfort_control` |
| `remote_steering_wheel_heat_level_request` | 设置方向盘加热档位 | `vehicle_comfort_control` |
| `remote_auto_steering_wheel_heat_climate_request` | 设置自动方向盘加热 | `vehicle_comfort_control` |

### 车窗/天窗/开闭件

| Tesla function | 用途 | 建议映射 |
| --- | --- | --- |
| `window_control` | 控制车窗通风或关闭 | `vehicle_window_control` |
| `sun_roof_control` | 控制天窗关闭、通风或停止 | `vehicle_sunroof_control` |
| `actuate_trunk` | 控制前备箱或后备箱 | `vehicle_closure_control` |
| `charge_port_door_open` | 打开充电口盖 | `vehicle_closure_control` |
| `charge_port_door_close` | 关闭充电口盖 | `vehicle_closure_control` |

### 灯光/声音/定位提示

| Tesla function | 用途 | 建议映射 |
| --- | --- | --- |
| `flash_lights` | 短暂闪烁车灯 | `vehicle_light_control` |
| `honk_horn` | 鸣笛 | `vehicle_sound_control` |
| `remote_boombox` | 通过外部扬声器播放提示音，例如定位提示音 | `vehicle_sound_control` |

### 充电控制

| Tesla function | 用途 | 建议映射 |
| --- | --- | --- |
| `charge_start` | 开始充电 | `vehicle_charging_control` |
| `charge_stop` | 停止充电 | `vehicle_charging_control` |
| `set_charge_limit` | 设置充电上限 | `vehicle_charging_control` |
| `set_charging_amps` | 设置充电电流 | `vehicle_charging_control` |
| `charge_standard` | 设置标准续航充电模式 | `vehicle_charging_control` |
| `charge_max_range` | 设置最大续航充电模式 | `vehicle_charging_control` |
| `add_charge_schedule` | 添加充电计划 | `vehicle_charging_control` |
| `remove_charge_schedule` | 删除充电计划 | `vehicle_charging_control` |
| `set_scheduled_charging` | 设置预约充电。Tesla 文档标注 2024.26 起不推荐，优先使用 `add_charge_schedule` | `vehicle_charging_control` |

## 参数建议

### `vehicle_state_query`

`part` 建议枚举：

| 值 | 含义 |
| --- | --- |
| `all` | 全部车辆状态 |
| `climate` | 空调/座舱温控 |
| `temperature` | 温度 |
| `comfort` | 座椅/方向盘舒适控制 |
| `windows` | 车窗 |
| `sunroof` | 天窗 |
| `closures` | 前/后备箱、充电口 |
| `lights` | 灯光 |
| `sound` | 声音/定位提示能力 |
| `charging` | 充电状态 |

### 控制类通用参数

- `action` 表示动作，例如 `open`、`close`、`start`、`stop`、`set`、`increase`、`decrease`、`vent`、`flash`、`honk`。
- `target` 表示被控对象，例如 `front_trunk`、`rear_trunk`、`charge_port`、`seat_heater`、`seat_cooler`、`steering_wheel_heater`。
- `zone` / `seat` 表示区域或座位，例如 `driver`、`passenger`、`front`、`rear`、`all`。
- `level` 表示档位，适用于座椅加热/通风、方向盘加热等。
- `temperature` / `delta` 表示目标温度或相对调节幅度。

## 调用原则

- 用户问状态时只调用 `vehicle_state_query`，不要用控制工具代替查询。
- 用户明确要改变车辆状态时调用对应控制工具。
- 不按固定话术、固定值或开关状态拆工具；话术写入 description/examples，固定值做成枚举参数。
- 一次性动作和持久状态要区分：`flash_lights`、`honk_horn`、`remote_boombox` 更像触发动作，不一定需要长期写入状态。
- `vehicle_climate_control` 负责空调预处理开关，`vehicle_temperature_control` 负责温度数值调节，避免单个 schema 过宽。
- `vehicle_closure_control` 用于前/后备箱和充电口这类开闭件；车窗和天窗保留独立工具，因为它们有通风、开度、停止等更细行为。
- 充电计划类能力优先映射到 `add_charge_schedule` / `remove_charge_schedule`；`set_scheduled_charging` 仅作为兼容能力。
- 底层厂商 API 由服务层编排，不直接暴露给模型。

## 来源

- Tesla Fleet API - Vehicle Endpoints: https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints
- Tesla Fleet API - Vehicle Commands: https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-commands
