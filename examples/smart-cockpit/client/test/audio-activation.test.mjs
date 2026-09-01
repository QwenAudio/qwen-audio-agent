import assert from 'node:assert/strict'
import test from 'node:test'
import { activateAudioContext } from '../src/audio/activation.js'

test('resumes audio synchronously in the caller activation stack', async () => {
  let resumeCalled = false
  let releaseResume
  class AudioContextStub {
    state = 'suspended'

    resume() {
      resumeCalled = true
      return new Promise(resolve => {
        releaseResume = () => {
          this.state = 'running'
          resolve()
        }
      })
    }
  }

  const activation = activateAudioContext({ AudioContextClass: AudioContextStub })
  assert.equal(resumeCalled, true)
  releaseResume()
  assert.equal(await activation.ready, activation.context)
})

test('reuses a running context without resuming it again', async () => {
  const current = {
    state: 'running',
    resume() {
      throw new Error('must not resume a running context')
    },
  }
  const activation = activateAudioContext({
    current,
    AudioContextClass: class {},
  })

  assert.equal(activation.context, current)
  assert.equal(await activation.ready, current)
})

test('fails clearly when a browser leaves audio suspended', async () => {
  class AudioContextStub {
    state = 'suspended'
    resume() { return Promise.resolve() }
  }
  const activation = activateAudioContext({ AudioContextClass: AudioContextStub })

  await assert.rejects(activation.ready, /浏览器未允许启用语音/)
})
