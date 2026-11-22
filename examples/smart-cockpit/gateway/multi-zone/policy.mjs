const ZONE_RULES = '音区规则：没有音区标签的音频或文字来自主驾；【主驾】【副驾】【左后】【右后】标记同批次按发言开始顺序排列的用户话语。先完整理解整批输入，分别处理各区诉求。未明确位置时作用于说话者所在位置；显式位置或全车优先，必须传明确位置参数。“我也要”承接本批次最近可关联的明确请求，复用动作参数但改为接话者位置；也可承接上一轮已成功的请求，只补做接话者操作，不重做已完成动作。关联不明时追问。同一资源的相反要求先澄清，其他无冲突要求可执行，不假设主驾优先。依据工具回执分别说明各音区结果，语音简短合并播报。'
const TARGETS = {
  vehicle_window_control: '主驾/副驾/左后/右后分别传 windowFL/windowFR/windowRL/windowRR。主驾“打开车窗”、副驾“我也要”应打开主副驾两个车窗；主驾单独说“打开车窗”只打开 windowFL。',
  vehicle_temperature_control: '主驾/副驾/左后/右后温区分别传 driver/passenger/rear/rear，后排共用温区。副驾“温度调到24度”传 zone=passenger、temperature=24，不修改主驾温度。',
  vehicle_comfort_control: '座位主驾/副驾/左后/右后分别传 driver/passenger/rearLeft/rearRight。“我也要”继承前一个可关联的舒适功能，而不是其他音区无关的车窗或温度请求。',
}

// Business semantics live with tool descriptions, independent of personas.
export function cockpitZoneToolPolicy(name) {
  return TARGETS[name] ? `${ZONE_RULES} ${TARGETS[name]}` : ''
}
