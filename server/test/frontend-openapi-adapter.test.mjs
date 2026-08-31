import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  FrontendOpenApiAdapter,
} from '../src/providers/openapi/frontend-openapi-adapter.mjs'
import {
  normalizeFrontendOpenApiConfiguration,
} from '../src/providers/openapi/frontend-openapi-config.mjs'

const DOCUMENT = `
openapi: 3.1.0
info:
  title: Test API
  version: 1.0.0
servers:
  - url: https://api.example.test/v1
paths:
  /cities/{city}/weather:
    parameters:
      - name: city
        in: path
        required: true
        schema:
          type: string
    get:
      operationId: getWeather
      summary: Read current weather.
      parameters:
        - name: units
          in: query
          schema:
            type: string
            enum: [metric, imperial]
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RecursiveResponse'
  /alerts:
    post:
      operationId: createAlert
      summary: Create a weather alert.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Alert'
      responses:
        '201':
          description: Created
components:
  schemas:
    RecursiveResponse:
      type: object
      properties:
        child:
          $ref: '#/components/schemas/RecursiveResponse'
    Alert:
      type: object
      properties:
        city:
          type: string
        threshold:
          type: number
      required: [city, threshold]
      additionalProperties: false
`

function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-openapi-'))
  const documentPath = join(directory, 'weather.yaml')
  writeFileSync(documentPath, overrides.document || DOCUMENT, 'utf8')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const configuration = normalizeFrontendOpenApiConfiguration({
    version: 1,
    apis: {
      weather: {
        enabled: true,
        document: documentPath,
        headers: { authorization: '${API_TOKEN}' },
        operations: overrides.operations || {
          getWeather: { enabled: true },
          createAlert: { enabled: true },
        },
      },
    },
  }, { env: { API_TOKEN: 'Bearer secret' } })
  return { configuration, documentPath }
}

test('discovers only enabled operationIds with standard function schemas', async t => {
  const { configuration } = setup(t)
  const adapter = new FrontendOpenApiAdapter({ configuration })
  const tools = await adapter.initialize()

  assert.deepEqual(tools.map(tool => tool.name), [
    'openapi__weather__getWeather',
    'openapi__weather__createAlert',
  ])
  assert.deepEqual(tools[0].definition.function.parameters.required, ['city'])
  assert.equal(
    tools[0].definition.function.parameters.properties.units.enum[0],
    'metric',
  )
  assert.deepEqual(
    tools[1].definition.function.parameters.properties.body.required,
    ['city', 'threshold'],
  )
  assert.deepEqual(tools[1].policy, {
    mode: 'inline',
    timeoutMs: 8_000,
    maxResultBytes: 32 * 1024,
    maxCallsPerTurn: 2,
  })
  assert.deepEqual(adapter.health(), {
    ok: true,
    initialized: true,
    tools: 2,
    apis: [{
      key: 'weather',
      enabled: true,
      status: 'ready',
      tools: 2,
    }],
  })
})

test('executes path, query, headers, and JSON bodies through one adapter', async t => {
  const { configuration } = setup(t)
  const requests = []
  const adapter = new FrontendOpenApiAdapter({
    configuration,
    fetchImpl: async (url, init) => {
      requests.push({ url: url.toString(), init })
      return new Response(JSON.stringify({ ok: true, request: requests.length }), {
        status: requests.length === 1 ? 200 : 201,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  await adapter.initialize()

  const weather = await adapter.execute('openapi__weather__getWeather', {
    city: '杭州',
    units: 'metric',
  })
  const alert = await adapter.execute('openapi__weather__createAlert', {
    body: { city: '杭州', threshold: 35 },
  })

  assert.equal(
    requests[0].url,
    'https://api.example.test/v1/cities/%E6%9D%AD%E5%B7%9E/weather?units=metric',
  )
  assert.equal(requests[0].init.headers.authorization, 'Bearer secret')
  assert.equal(requests[0].init.method, 'GET')
  assert.equal(requests[1].init.method, 'POST')
  assert.equal(requests[1].init.headers['content-type'], 'application/json')
  assert.equal(requests[1].init.body, JSON.stringify({ city: '杭州', threshold: 35 }))
  assert.equal(weather.structured_content.request, 1)
  assert.equal(alert.http_status, 201)
  assert.match(weather.notice, /不可信数据/)
})

test('fails one API closed when an enabled operation is missing', async t => {
  const missing = setup(t, {
    operations: { missing: { enabled: true } },
  })
  const missingAdapter = new FrontendOpenApiAdapter({
    configuration: missing.configuration,
  })
  assert.deepEqual(await missingAdapter.initialize(), [])
  assert.equal(missingAdapter.health().ok, false)
  assert.match(missingAdapter.health().apis[0].error, /operation is missing/)
})

test('normalizes non-success responses as bounded untrusted tool data', async t => {
  const { configuration } = setup(t)
  const adapter = new FrontendOpenApiAdapter({
    configuration,
    fetchImpl: async () => new Response('rate limited', {
      status: 429,
      headers: { 'content-type': 'text/plain' },
    }),
  })
  await adapter.initialize()
  const result = await adapter.execute('openapi__weather__getWeather', {
    city: 'Hangzhou',
  })

  assert.equal(result.status, 'error')
  assert.equal(result.error_code, 'frontend_openapi_request_failed')
  assert.equal(result.retryable, true)
  assert.equal(result.text, 'rate limited')
})
