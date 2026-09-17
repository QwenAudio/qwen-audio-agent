import { AgentError } from '../../agent-error.mjs'
import {
  COORDINATOR_MCP_INSTRUCTIONS_MAX_BYTES,
  COORDINATOR_STABLE_INSTRUCTIONS,
} from './coordinator-instructions.mjs'

function clean(value) {
  return String(value || '').trim()
}

function modelKey(value) {
  return clean(value).toLowerCase()
}

function optionChoices(entries = []) {
  return entries.flatMap(entry => {
    if (Array.isArray(entry?.options)) return optionChoices(entry.options)
    const value = clean(entry?.value)
    if (!value) return []
    return [{
      value,
      names: [entry?.name, entry?.label]
        .map(clean)
        .filter(Boolean),
    }]
  })
}

function matchingOptionValue(entries, desired) {
  const desiredKey = modelKey(desired)
  const choice = optionChoices(entries).find(item => (
    modelKey(item.value) === desiredKey
    || item.names.some(name => modelKey(name) === desiredKey)
  ))
  return choice?.value || ''
}

function modelConfigOption(options = []) {
  return options.find(option => clean(option?.category).toLowerCase() === 'model')
    || options.find(option => (
      ['model', 'models'].includes(clean(option?.id).toLowerCase())
    ))
    || null
}

export function normalizeAcpModel(value) {
  const model = clean(value)
  return model.toLowerCase() === 'auto' ? '' : model
}

export function stableCoordinatorInstructions(profile) {
  return [
    COORDINATOR_STABLE_INSTRUCTIONS,
    clean(profile.sessionInstructions),
  ].filter(Boolean).join('\n\n')
}

export function coordinatorUsesMcpInstructions(profile) {
  return profile.coordinatorMcpInstructions === true
    && Buffer.byteLength(stableCoordinatorInstructions(profile), 'utf8')
      <= COORDINATOR_MCP_INSTRUCTIONS_MAX_BYTES
}

export function coordinatorMeta(profile, ownerId) {
  return profile.coordinatorMeta?.(ownerId) || null
}

async function applyProfileSessionConfig({
  client,
  profile,
  label,
  protocol,
}, session, initialOptions) {
  let options = initialOptions
  for (const setting of profile.sessionConfigOptions || []) {
    const id = clean(setting?.id)
    const desired = clean(setting?.value)
    const option = options.find(item => clean(item?.id) === id)
    const selected = option?.type === 'select'
      ? matchingOptionValue(option.options, desired)
      : desired
    if (!option || !selected) {
      throw new AgentError(
        `${label} 没有通过 ACP 提供必要的 Session 配置 ${id}=${desired}`,
        { status: 422, protocol },
      )
    }
    if (modelKey(option.currentValue) === modelKey(selected)) continue
    let response
    try {
      response = await client.setSessionConfigOption(
        session.sessionId,
        id,
        selected,
      )
    } catch (error) {
      throw new AgentError(
        `${label} 无法设置 Session 配置 ${id}=${desired}：${
          clean(error?.message) || '未知错误'
        }`,
        { status: error.status || 502, protocol },
      )
    }
    const updatedOptions = Array.isArray(response?.configOptions)
      ? response.configOptions
      : null
    const updated = updatedOptions?.find(item => clean(item?.id) === id)
    if (modelKey(updated?.currentValue) !== modelKey(selected)) {
      throw new AgentError(
        `${label} 未确认 Session 配置生效：要求 ${id}=${desired}，实际 ${
          clean(updated?.currentValue) || '未知'
        }`,
        { status: 502, protocol },
      )
    }
    options = updatedOptions
    session.response = {
      ...(session.response || {}),
      configOptions: options,
    }
  }
  return options
}

async function forceSessionModel({
  client,
  label,
  model,
  protocol,
}, session, options) {
  const option = modelConfigOption(options)
  if (!option) {
    throw new AgentError(
      `${label} 没有通过 ACP 提供 Session 模型配置，`
      + `无法强制使用模型 ${model}`,
      { status: 422, protocol },
    )
  }
  const values = optionChoices(option.options).map(entry => entry.value)
  const selected = option.type === 'select'
    ? matchingOptionValue(option.options, model)
    : model
  if (option.type === 'select' && !selected) {
    const available = values.length
      ? `；可选模型：${values.slice(0, 12).join('、')}`
      : ''
    throw new AgentError(
      `${label} 当前 Session 不支持模型 ${model}${available}`,
      { status: 422, protocol },
    )
  }
  if (modelKey(option.currentValue) === modelKey(selected)) return
  let response
  try {
    response = await client.setSessionConfigOption(
      session.sessionId,
      option.id,
      selected,
    )
  } catch (error) {
    throw new AgentError(
      `${label} 无法把 Session 模型设置为 ${model}：${
        clean(error?.message) || '未知错误'
      }`,
      { status: error.status || 502, protocol },
    )
  }
  const updatedOptions = Array.isArray(response?.configOptions)
    ? response.configOptions
    : null
  if (!updatedOptions) {
    throw new AgentError(
      `${label} 设置模型后没有返回 ACP configOptions，`
      + `无法确认模型 ${model} 已生效`,
      { status: 502, protocol },
    )
  }
  const updated = updatedOptions.find(item => (
    clean(item?.id) === clean(option.id)
  )) || modelConfigOption(updatedOptions)
  if (modelKey(updated?.currentValue) !== modelKey(selected)) {
    throw new AgentError(
      `${label} 未确认模型覆盖生效：要求 ${model}，`
      + `实际 ${clean(updated?.currentValue) || '未知'}`,
      { status: 502, protocol },
    )
  }
  session.response = {
    ...(session.response || {}),
    configOptions: updatedOptions,
  }
}

export async function configureAcpSession({
  client,
  coordinatorAgent,
  label,
  model,
  profile,
  protocol,
}, session, role) {
  let options = Array.isArray(session?.response?.configOptions)
    ? session.response.configOptions
    : []
  if (role === 'coordinator' && coordinatorAgent) {
    const configId = 'mode'
    const option = options.find(item => clean(item?.id) === configId)
    const supported = option?.type !== 'select'
      || option.options?.some(item => item.value === coordinatorAgent)
    if (option && supported && option.currentValue !== coordinatorAgent) {
      await client.setSessionConfigOption(
        session.sessionId,
        configId,
        coordinatorAgent,
      )
      option.currentValue = coordinatorAgent
    }
  }
  options = await applyProfileSessionConfig({
    client,
    profile,
    label,
    protocol,
  }, session, options)
  if (model && profile.sessionModelConfiguration !== false) {
    await forceSessionModel({ client, label, model, protocol }, session, options)
  }
}
