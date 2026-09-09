import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { desktopClientPaths } from '../src/client-paths.mjs'

test('all desktop assets, caches, credentials and logs belong to Electron userData', () => {
  const directory = resolve('desktop-client')
  const paths = desktopClientPaths(directory)
  assert.deepEqual(paths, {
    directory,
    skinsDirectory: resolve(directory, 'skins'),
    wakeWordModelDirectory: resolve(directory, 'cache/models/wake-word'),
    pathCacheFile: resolve(directory, 'cache/login-shell-path.json'),
    logDirectory: resolve(directory, 'logs'),
    credentialsPath: resolve(directory, 'gateway-credentials.json'),
    connectionsPath: resolve(directory, 'gateway-connections.json'),
  })
  assert.throws(() => desktopClientPaths(), /required/)
})

test('desktop wiring never uses Gateway directories for client resources', () => {
  const source = readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8')
  assert.match(source, /desktopClientPaths\(app.getPath\('userData'\)\)/)
  assert.match(source, /defaultStateDirectory: 'state\/desktop'/)
  assert.match(source, /clientDir: clientPaths.directory/)
  assert.match(source, /modelRoot: clientPaths.wakeWordModelDirectory/)
  assert.match(source, /directory: clientPaths.logDirectory/)
  assert.match(source, /cacheFile: clientPaths.pathCacheFile/)
  assert.doesNotMatch(source, /runtimeEnvironment\.(?:dataDirectory|cacheDirectory)/)
  assert.doesNotMatch(source, /writeFileSync\(runtimeEnvironment.configPath/)
})
