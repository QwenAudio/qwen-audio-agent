import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import concurrently from 'concurrently'

test('patched shell quoting preserves concurrently commands with quoted arguments', async () => {
  const output = new PassThrough()
  let text = ''
  output.on('data', chunk => { text += chunk.toString() })
  const { result } = concurrently([
    `node --eval "process.stdout.write('first quoted value')"`,
    `node --eval "process.stdout.write('second quoted value')"`,
  ], { raw: false, prefix: 'none', outputStream: output })
  const completed = await result
  assert.equal(completed.length, 2)
  assert.ok(completed.every(command => command.exitCode === 0))
  assert.ok(text.includes('first quoted value'))
  assert.ok(text.includes('second quoted value'))
})

test('maintained global proxy bootstrap still routes build downloads through a local proxy', { timeout: 15_000 }, async t => {
  const requests = []
  const proxy = createServer((request, response) => {
    requests.push(request.url)
    response.end('local proxy download')
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(async () => {
    proxy.closeAllConnections()
    await new Promise(resolve => proxy.close(resolve))
  })
  const child = spawn(process.execPath, ['--eval', `
    const buildRequire = require('node:module').createRequire(require.resolve('app-builder-lib'));
    buildRequire('@electron/get').initializeProxy();
    const request = require('node:http').get('http://proxy-test.invalid/artifact', response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk });
      response.on('end', () => process.stdout.write(body));
    });
    request.on('error', error => { process.stderr.write(error.message); process.exitCode = 1 });
  `], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env,
      GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
      GLOBAL_AGENT_HTTPS_PROXY: '', GLOBAL_AGENT_NO_PROXY: '',
      GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE: 'GLOBAL_AGENT_',
      GLOBAL_AGENT_SOCKET_CONNECTION_TIMEOUT: '2000',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { errors += chunk.toString() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, errors)
  assert.equal(output, 'local proxy download')
  assert.deepEqual(requests, ['http://proxy-test.invalid/artifact'])
})
