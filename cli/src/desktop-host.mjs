import { timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  readFile as nodeReadFile,
  readFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import { writeFileAtomic as defaultWriteFileAtomic } from '../../shared/atomic-file.mjs'
import {
  createDesktopHostJsonLineDecoder,
  DesktopHostRequestSchema,
  DESKTOP_HOST_PROTOCOL_VERSION,
  encodeDesktopHostMessage,
  redactDesktopHostValue,
} from '../../shared/desktop-host-protocol.mjs'
import {
  parseSettings,
  updateSettingsContent,
} from '../../shared/desktop-settings.mjs'
import { inspectBackendSetups as defaultInspectBackendSetups } from '../../shared/backend-setup.mjs'
import { loadRuntimeEnvironment as defaultLoadRuntimeEnvironment } from '../../shared/runtime-environment.mjs'
import { DesktopHostGateway } from './desktop-host-gateway.mjs'

export const DESKTOP_HOST_SESSION_TOKEN_ENV =
  'QWEN_AUDIO_DESKTOP_SESSION_TOKEN'
export const DESKTOP_HOST_DISABLE_GATEWAY_ENV =
  'QWEN_AUDIO_DESKTOP_HOST_DISABLE_GATEWAY'

const packageVersion = JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
)).version
const SESSION_TOKEN_PATTERN = /^[a-f\d]{64}$/i
const REQUEST_ID_PATTERN = /^.{1,128}$/s
const SHUTDOWN_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM']
const SECRET_SETTING_FIELDS = [
  'dashscopeApiKey',
  'speechToSpeechAuthToken',
]

const EmptyParamsSchema = z.object({}).strict()
const SessionParamsSchema = z.object({
  sessionToken: z.string(),
}).strict()
const SecretSettingSchema = z.union([
  z.string().max(16_384),
  z.object({ configured: z.boolean() }).strict(),
])
const SettingsUpdateSchema = z.object({
  gatewayUrl: z.string().max(4_096).optional(),
  orbStyle: z.string().max(128).optional(),
  dashscopeApiKey: SecretSettingSchema.optional(),
  realtimeProvider: z.string().max(128).optional(),
  agentProtocol: z.string().max(128).optional(),
  realtimeModel: z.string().max(512).optional(),
  speechToSpeechRealtimeUrl: z.string().max(4_096).optional(),
  speechToSpeechAuthToken: SecretSettingSchema.optional(),
  backendModel: z.string().max(512).optional(),
}).strict()
const SettingsWriteParamsSchema = z.object({
  sessionToken: z.string(),
  settings: SettingsUpdateSchema,
}).strict()
const BackendInspectParamsSchema = z.object({
  backend: z.string().max(128).optional(),
}).strict()
const LogsTailParamsSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
}).strict()

class DesktopHostRequestError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'DesktopHostRequestError'
    this.code = code
  }
}

class DisabledTestGateway extends EventEmitter {
  constructor() {
    super()
    this.status = {
      state: 'stopping',
      origin: null,
      retry: 0,
      delayMs: null,
      reason: null,
    }
  }

  async start() {
    throw new Error('Gateway spawning is disabled for this test host')
  }

  async restart() {
    throw new Error('Gateway spawning is disabled for this test host')
  }

  async stop() {}

  tailLogs() {
    return []
  }
}

function readFileUtf8(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    nodeReadFile(path, 'utf8', (error, content) => {
      if (error) rejectPromise(error)
      else resolvePromise(content)
    })
  })
}

function cleanErrorMessage(error) {
  return String(redactDesktopHostValue(
    error?.message || error || 'Unknown desktop host error',
  ))
}

function sanitizedSettings(settings) {
  const result = { ...settings }
  for (const field of SECRET_SETTING_FIELDS) {
    result[field] = { configured: Boolean(settings[field]) }
  }
  return result
}

function settingsForUpdate(settings) {
  const result = { ...settings }
  for (const field of SECRET_SETTING_FIELDS) {
    if (result[field] && typeof result[field] === 'object') delete result[field]
  }
  return result
}

function tokenMatches(expectedToken, receivedToken) {
  if (
    !SESSION_TOKEN_PATTERN.test(expectedToken)
    || !SESSION_TOKEN_PATTERN.test(String(receivedToken || ''))
  ) return false
  const expected = Buffer.from(expectedToken, 'hex')
  const received = Buffer.from(receivedToken, 'hex')
  return expected.length === received.length
    && timingSafeEqual(expected, received)
}

function assertAuthenticated(params, expectedToken) {
  if (!tokenMatches(expectedToken, params.sessionToken)) {
    throw new DesktopHostRequestError(
      'unauthorized',
      'Desktop host session authentication failed',
    )
  }
}

function gatewayEnvironment({ env, configPath, root }) {
  let configured = {}
  try {
    configured = parseEnv(readFileSync(configPath, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const merged = { ...env, ...configured }
  if (Object.hasOwn(configured, 'DASHSCOPE_API_KEY')) {
    merged.QWEN_AUDIO_REALTIME_API_KEY = configured.DASHSCOPE_API_KEY
  }
  return {
    ...merged,
    QWEN_AUDIO_AGENT_DESKTOP: '1',
    QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY: '1',
    QWEN_AUDIO_AGENT_RUNTIME_ROOT: root,
  }
}

function writeStream(stream, content) {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.write(content, error => {
      if (error) rejectPromise(error)
      else resolvePromise()
    })
  })
}

function endStream(stream) {
  if (typeof stream.end !== 'function' || stream.writableEnded) {
    return Promise.resolve()
  }
  return new Promise(resolvePromise => stream.end(resolvePromise))
}

function requestIdFromInvalidValue(value) {
  return value
    && typeof value === 'object'
    && typeof value.id === 'string'
    && REQUEST_ID_PATTERN.test(value.id)
    ? value.id
    : null
}

function asRequestError(error) {
  if (error instanceof DesktopHostRequestError) return error
  if (error instanceof z.ZodError) {
    return new DesktopHostRequestError(
      'invalid_params',
      'Desktop host request parameters are invalid',
    )
  }
  return new DesktopHostRequestError(
    'operation_failed',
    cleanErrorMessage(error),
  )
}

export async function runDesktopHost({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  dependencies = {},
} = {}) {
  const env = dependencies.env || process.env
  const root = dependencies.root
  if (!root) throw new Error('Desktop host requires a runtime root')
  const sessionToken = String(env[DESKTOP_HOST_SESSION_TOKEN_ENV] || '')
  if (!SESSION_TOKEN_PATTERN.test(sessionToken)) {
    throw new Error('Desktop host requires a 32-byte hexadecimal session token')
  }
  const disableGateway = env[DESKTOP_HOST_DISABLE_GATEWAY_ENV] === '1'
  if (disableGateway && env.NODE_ENV !== 'test') {
    throw new Error('The desktop host Gateway test override requires NODE_ENV=test')
  }
  delete env[DESKTOP_HOST_SESSION_TOKEN_ENV]
  delete env[DESKTOP_HOST_DISABLE_GATEWAY_ENV]

  const signalSource = dependencies.signalSource || process
  const loadRuntimeEnvironment = dependencies.loadRuntimeEnvironment
    || defaultLoadRuntimeEnvironment
  const inspectBackendSetups = dependencies.inspectBackendSetups
    || defaultInspectBackendSetups
  const readFile = dependencies.readFile || readFileUtf8
  const writeFileAtomic = dependencies.writeFileAtomic
    || defaultWriteFileAtomic
  const hostPackageVersion = dependencies.packageVersion || packageVersion
  const nodeVersion = dependencies.nodeVersion || process.versions.node
  const distribution = dependencies.distribution
    || String(env.WSL_DISTRO_NAME || '')
  const runtime = loadRuntimeEnvironment({
    root,
    env,
    prepareBackendRuntime: false,
  })
  const gateway = dependencies.createGateway
    ? dependencies.createGateway({ runtime, root, env })
    : disableGateway
      ? new DisabledTestGateway()
      : new DesktopHostGateway({
          entryPath: resolve(root, 'server/src/index.mjs'),
          environmentFactory: () => gatewayEnvironment({
            env,
            configPath: runtime.configPath,
            root,
          }),
        })

  let writeQueue = Promise.resolve()
  let requestQueue = Promise.resolve()
  let shuttingDown = false
  let shutdownPromise = null
  let resolveCompletion
  const completion = new Promise(resolvePromise => {
    resolveCompletion = resolvePromise
  })

  const diagnose = error => {
    const message = cleanErrorMessage(error)
    errorOutput.write(`desktop-host: ${message}\n`)
  }
  const send = message => {
    if (shuttingDown && message.event) return Promise.resolve()
    const line = encodeDesktopHostMessage(message)
    writeQueue = writeQueue.then(() => writeStream(output, line))
    return writeQueue
  }
  const onGatewayStatus = status => {
    void send({
      event: 'gateway.status',
      data: redactDesktopHostValue(status),
    }).catch(diagnose)
  }
  gateway.on('status', onGatewayStatus)

  const removeListeners = () => {
    input.off?.('data', onInputData)
    input.off?.('end', onInputEnd)
    input.off?.('error', onInputError)
    input.pause?.()
    gateway.off('status', onGatewayStatus)
    for (const signal of SHUTDOWN_SIGNALS) {
      signalSource.off(signal, signalHandlers[signal])
    }
  }

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    removeListeners()
    shutdownPromise = (async () => {
      let exitCode = 0
      try {
        await gateway.stop()
      } catch (error) {
        exitCode = 1
        diagnose(error)
      }
      try {
        await writeQueue
        await endStream(output)
      } catch (error) {
        exitCode = 1
        diagnose(error)
      }
      resolveCompletion(exitCode)
      return exitCode
    })()
    return shutdownPromise
  }

  async function readSettingsContent() {
    try {
      return await readFile(runtime.configPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return ''
      throw error
    }
  }

  async function invoke(method, rawParams) {
    switch (method) {
      case 'runtime.status': {
        EmptyParamsSchema.parse(rawParams)
        return {
          protocol: DESKTOP_HOST_PROTOCOL_VERSION,
          packageVersion: hostPackageVersion,
          nodeVersion,
          distribution,
          runtime: {
            configDirectory: runtime.configDirectory,
            configPath: runtime.configPath,
          },
          gateway: { ...gateway.status },
        }
      }
      case 'settings.read': {
        EmptyParamsSchema.parse(rawParams)
        const content = await readSettingsContent()
        return {
          settings: sanitizedSettings(parseSettings(content, env)),
          runtime: { configPath: runtime.configPath },
        }
      }
      case 'settings.write': {
        const params = SettingsWriteParamsSchema.parse(rawParams)
        assertAuthenticated(params, sessionToken)
        const previousContent = await readSettingsContent()
        const update = settingsForUpdate(params.settings)
        let nextContent
        try {
          nextContent = updateSettingsContent(previousContent, update)
        } catch (error) {
          throw new DesktopHostRequestError(
            'invalid_params',
            cleanErrorMessage(error),
          )
        }
        await writeFileAtomic(runtime.configPath, nextContent, { mode: 0o600 })
        let origin
        try {
          origin = await gateway.restart()
        } catch (restartError) {
          let rollbackError = null
          try {
            await writeFileAtomic(
              runtime.configPath,
              previousContent,
              { mode: 0o600 },
            )
            await gateway.restart()
          } catch (error) {
            rollbackError = error
          }
          const suffix = rollbackError
            ? '; previous configuration recovery also failed'
            : ''
          throw new DesktopHostRequestError(
            'settings_restart_failed',
            `Gateway rejected the updated settings${suffix}`,
            { cause: restartError },
          )
        }
        return {
          settings: sanitizedSettings(parseSettings(nextContent, env)),
          origin,
        }
      }
      case 'backends.inspect': {
        const params = BackendInspectParamsSchema.parse(rawParams)
        return inspectBackendSetups({
          env,
          backend: params.backend || '',
        })
      }
      case 'gateway.start': {
        const params = SessionParamsSchema.parse(rawParams)
        assertAuthenticated(params, sessionToken)
        const origin = await gateway.start()
        await send({
          event: 'gateway.ready',
          data: { origin, owned: true },
        })
        return { origin }
      }
      case 'gateway.restart': {
        const params = SessionParamsSchema.parse(rawParams)
        assertAuthenticated(params, sessionToken)
        const origin = await gateway.restart()
        await send({
          event: 'gateway.ready',
          data: { origin, owned: true },
        })
        return { origin }
      }
      case 'gateway.stop': {
        const params = SessionParamsSchema.parse(rawParams)
        assertAuthenticated(params, sessionToken)
        await gateway.stop()
        return { stopped: true }
      }
      case 'logs.tail': {
        const params = LogsTailParamsSchema.parse(rawParams)
        return {
          logs: redactDesktopHostValue(
            gateway.tailLogs({ limit: params.limit || 100 }),
          ),
        }
      }
      case 'host.shutdown': {
        const params = SessionParamsSchema.parse(rawParams)
        assertAuthenticated(params, sessionToken)
        return { shuttingDown: true }
      }
      default:
        throw new DesktopHostRequestError(
          'method_not_found',
          'Desktop host method is not supported',
        )
    }
  }

  async function processRequest(request) {
    try {
      const result = await invoke(request.method, request.params)
      await send({ id: request.id, ok: true, result })
      if (request.method === 'host.shutdown') await shutdown()
    } catch (error) {
      const requestError = asRequestError(error)
      await send({
        id: request.id,
        ok: false,
        error: {
          code: requestError.code,
          message: cleanErrorMessage(requestError),
        },
      })
    }
  }

  const decoder = createDesktopHostJsonLineDecoder({
    onMessage: message => {
      if (shuttingDown) return
      const request = DesktopHostRequestSchema.safeParse(message)
      if (!request.success) {
        diagnose(new Error('Desktop host received a non-request envelope'))
        requestQueue = requestQueue.finally(() => shutdown())
        return
      }
      requestQueue = requestQueue
        .then(() => processRequest(request.data))
        .catch(error => {
          diagnose(error)
          return shutdown()
        })
    },
    onError: (error, context) => {
      const id = requestIdFromInvalidValue(context?.value)
      if (id && !shuttingDown) {
        requestQueue = requestQueue.then(() => send({
          id,
          ok: false,
          error: {
            code: 'invalid_request',
            message: 'Desktop host request envelope is invalid',
          },
        }))
        return
      }
      diagnose(error)
      requestQueue = requestQueue.finally(() => shutdown())
    },
  })

  function onInputData(chunk) {
    try {
      decoder.push(chunk)
    } catch (error) {
      diagnose(error)
      void shutdown()
    }
  }
  function onInputEnd() {
    decoder.end()
    requestQueue = requestQueue.finally(() => shutdown())
  }
  function onInputError(error) {
    diagnose(error)
    requestQueue = requestQueue.finally(() => shutdown())
  }
  const signalHandlers = Object.fromEntries(SHUTDOWN_SIGNALS.map(signal => [
    signal,
    () => {
      requestQueue = requestQueue.finally(() => shutdown())
    },
  ]))

  input.on('data', onInputData)
  input.once('end', onInputEnd)
  input.once('error', onInputError)
  input.resume?.()
  for (const signal of SHUTDOWN_SIGNALS) {
    signalSource.once(signal, signalHandlers[signal])
  }

  await send({
    event: 'hello',
    data: {
      protocol: DESKTOP_HOST_PROTOCOL_VERSION,
      packageVersion: hostPackageVersion,
      nodeVersion,
      distribution,
    },
  })
  return completion
}
