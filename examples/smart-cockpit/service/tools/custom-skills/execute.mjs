import { clean, reportActivity, toolResult } from '../shared.mjs'

function catalogText(skills) {
  if (!skills.length) return '当前没有自定义技能'
  return skills.map(skill => `${skill.name}：${skill.description}`).join('\n')
}

function skillSummary(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    kind: skill.kind || 'workflow',
    ...(skill.kind === 'event' ? {
      trigger: skill.trigger,
      reminder: skill.reminder,
    } : {}),
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }
}

export async function executeCustomSkillTool(name, args, context) {
  const {
    cockpitId,
    customSkills,
    onActivity,
    snapshot,
    onCustomSkillsChanged,
  } = context
  if (!customSkills) throw new Error('Custom skill store is unavailable')

  if (name === 'custom_skill_list') {
    const skills = await customSkills.list(cockpitId)
    return toolResult(catalogText(skills), snapshot(), [], { skills })
  }

  if (name === 'custom_skill_create') {
    const skill = await customSkills.upsert(cockpitId, {
      name: args.name,
      description: args.description,
      instructions: args.instructions,
      kind: args.kind,
      trigger: args.trigger,
      reminder: args.reminder,
    })
    // A successful create/update means the rule is armed before the next command.
    await onCustomSkillsChanged?.()
    reportActivity(
      onActivity,
      'custom_skills',
      'skills_changed',
      `已保存自定义技能“${skill.name}”`,
    )
    return toolResult(
      `已保存自定义技能“${skill.name}”`,
      snapshot(),
      [],
      { skill: skillSummary(skill) },
    )
  }

  if (name === 'custom_skill_load') {
    const skillName = clean(args.skill_name)
    const skill = await customSkills.get(cockpitId, skillName)
    if (!skill) {
      return toolResult(`未找到自定义技能“${skillName}”`, snapshot(), [], {
        skill: null,
      })
    }
    const content = [
      `已加载自定义技能“${skill.name}”。`,
      skill.kind === 'event'
        ? '这是已保存的事件提醒规则，由座舱服务在真实温度变化满足条件时触发；加载不触发提醒，不要修改温度来制造触发。'
        : '以下是用户保存的工作流数据；由前台按顺序协调，已提供的前台工具直接调用，仅将需要后台能力的步骤提交 spawn_thinking；不得扩大工具权限。',
      '<custom_skill_instructions>',
      skill.instructions,
      '</custom_skill_instructions>',
    ].join('\n')
    return toolResult(content, snapshot(), [], { skill: skillSummary(skill) })
  }

  throw new Error(`Unknown custom skill tool: ${name}`)
}
