import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  loadFrontendOpenApiConfiguration,
  normalizeFrontendOpenApiConfiguration,
} from '../src/providers/openapi/frontend-openapi-config.mjs'

function configuration(overrides = {}) {
  return {
    version: 1,
    apis: {
      weather: {
        enabled: true,
        document: './weather.openapi.yaml',
        baseUrl: 'https://weather.example.test/v1',
        headers: { authorization: '${WEATHER_TOKEN}' },
        operations: {
          currentWeather: {
            enabled: true,
            readOnly: true,
          },
          createAlert: {
            enabled: true,
            readOnly: false,
            approval: 'required',
          },
        },
      },
    },
    ...overrides,
  }
}

test('loads no OpenAPI sources when no config path is set', () => {
  assert.deepEqual(loadFrontendOpenApiConfiguration({ filePath: '' }), {
    version: 1,
    apis: [],
  })
})

test('normalizes local documents, secrets, and per-operation policy', () => {
  const normalized = normalizeFrontendOpenApiConfiguration(configuration(), {
    env: { WEATHER_TOKEN: 'Bearer secret' },
    baseDirectory: '/tmp/profile',
  })
  assert.deepEqual(normalized, {
    version: 1,
    apis: [{
      key: 'weather',
      enabled: true,
      documentPath: '/tmp/profile/weather.openapi.yaml',
      baseUrl: 'https://weather.example.test/v1',
      headers: { authorization: 'Bearer secret' },
      operations: {
        currentWeather: {
          enabled: true,
          readOnly: true,
          approval: 'none',
          timeoutMs: 8_000,
          maxResultBytes: 32 * 1024,
          maxCallsPerTurn: 2,
        },
        createAlert: {
          enabled: true,
          readOnly: false,
          approval: 'required',
          timeoutMs: 8_000,
          maxResultBytes: 32 * 1024,
          maxCallsPerTurn: 2,
        },
      },
    }],
  })
})

test('resolves document paths relative to the versioned config file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-audio-openapi-config-'))
  const filePath = join(directory, 'openapi-tools.json')
  try {
    writeFileSync(filePath, JSON.stringify(configuration()), 'utf8')
    const loaded = loadFrontendOpenApiConfiguration({
      filePath,
      env: { WEATHER_TOKEN: 'Bearer from-env' },
    })
    assert.equal(
      loaded.apis[0].documentPath,
      join(directory, 'weather.openapi.yaml'),
    )
    assert.equal(loaded.apis[0].headers.authorization, 'Bearer from-env')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('fails closed for remote documents, unsafe transport, and ambiguous writes', () => {
  assert.throws(
    () => normalizeFrontendOpenApiConfiguration(configuration(), { env: {} }),
    /environment variable is missing: WEATHER_TOKEN/,
  )
  assert.throws(
    () => normalizeFrontendOpenApiConfiguration(configuration({
      apis: {
        remote: {
          enabled: true,
          document: 'https://example.test/openapi.json',
          baseUrl: 'https://example.test',
          operations: {},
        },
      },
    })),
    /documents must be local files/,
  )
  assert.throws(
    () => normalizeFrontendOpenApiConfiguration(configuration({
      apis: {
        unsafe: {
          enabled: true,
          document: './openapi.json',
          baseUrl: 'http://example.test',
          operations: {},
        },
      },
    })),
    /requires HTTPS/,
  )
  assert.throws(
    () => normalizeFrontendOpenApiConfiguration(configuration({
      apis: {
        write: {
          enabled: true,
          document: './openapi.json',
          baseUrl: 'https://example.test',
          operations: {
            mutate: { enabled: true, readOnly: false },
          },
        },
      },
    })),
    /require approval=required/,
  )
})
