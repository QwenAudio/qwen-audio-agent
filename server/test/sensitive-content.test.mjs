import assert from 'node:assert/strict'
import test from 'node:test'
import {
  containsSensitiveContent,
  SENSITIVE_PATTERNS,
} from '../src/core/sensitive-content.mjs'

test('blocks credential keywords in both languages', () => {
  for (const text of [
    'API_KEY=sk-xxx',
    'my api-key is in the vault',
    'access-key: AKID',
    'client secret stored in env',
    'refresh_token=abc',
    'please set your password',
    'Passwd: 123',
    '把数据库密码记一下',
    '口令是四位数',
    '验证码是 492013',
    '这个接口要用令牌鉴权',
    '他的证件号我先记下',
  ]) {
    assert.equal(containsSensitiveContent(text), true, text)
  }
})

test('blocks secret-shaped strings without keywords', () => {
  // sk- 前缀密钥
  assert.equal(containsSensitiveContent('sk-a1b2c3d4e5f6g7h8'), true)
  // 11-19 位连续数字：手机号、银行卡、证件号
  assert.equal(containsSensitiveContent('13812345678'), true)
  assert.equal(containsSensitiveContent('6222020200112233445'), true)
  // base64 风格长串
  assert.equal(
    containsSensitiveContent('YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5'),
    true,
  )
})

test('keeps the digit-run boundaries of the 11-19 window', () => {
  assert.equal(containsSensitiveContent('1'.repeat(10)), false)
  assert.equal(containsSensitiveContent('1'.repeat(11)), true)
  assert.equal(containsSensitiveContent('1'.repeat(19)), true)
  // 20 位不回配：{11,19} 之后要求 \b，长串内部无法满足。
  assert.equal(containsSensitiveContent('1'.repeat(20)), false)
})

test('keeps the 40-character boundary of the base64-style pattern', () => {
  assert.equal(containsSensitiveContent('a'.repeat(39)), false)
  assert.equal(containsSensitiveContent('a'.repeat(40)), true)
})

test('lets ordinary conversation content through', () => {
  for (const text of [
    '',
    undefined,
    null,
    '今天天气不错，适合出去走走',
    '我明天上午十点开会，记得提醒我',
    '帮我把这段代码改成 async 函数',
    '1234567890',
    'short string',
  ]) {
    assert.equal(containsSensitiveContent(text), false, String(text))
  }
})

test('errs on the side of over-blocking, per the design stance', () => {
  // 闸门的取向是宁可误伤：token 的派生词也会命中，由调用方承担误伤代价。
  assert.equal(containsSensitiveContent('we tokenize the input text'), true)
})

test('pins the known delimiter limitation of the digit-run pattern', () => {
  // 已知现状：带分隔符的号码各段都短于 11 位，不命中长数字串模式。
  // 若日后收紧模式，请同步更新此断言。
  assert.equal(containsSensitiveContent('138-1234-5678'), false)
})

test('exposes the shared pattern list as regular expressions', () => {
  assert.ok(Array.isArray(SENSITIVE_PATTERNS))
  assert.ok(SENSITIVE_PATTERNS.length > 0)
  assert.ok(SENSITIVE_PATTERNS.every(pattern => pattern instanceof RegExp))
})
