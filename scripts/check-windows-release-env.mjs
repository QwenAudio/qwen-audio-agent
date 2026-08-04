#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

export function validateWindowsReleaseEnvironment(env = process.env) {
  const certificateLink = String(env.WIN_CSC_LINK || '').trim()
  const certificateSubject = String(env.WIN_CSC_SUBJECT_NAME || '').trim()
  const certificatePassword = String(env.WIN_CSC_KEY_PASSWORD || '').trim()
  if (!certificateLink && !certificateSubject) {
    throw new Error(
      '正式 Windows 构建缺少 WIN_CSC_LINK 或 WIN_CSC_SUBJECT_NAME。'
      + ' 本机未签名测试请运行 npm run desktop:build:win:local。',
    )
  }
  if (certificateLink && certificateSubject) {
    throw new Error(
      '正式 Windows 构建只能选择 WIN_CSC_LINK 或 WIN_CSC_SUBJECT_NAME 其中一种。',
    )
  }
  if (certificateLink && !certificatePassword) {
    throw new Error('正式 Windows 构建使用证书文件时缺少 WIN_CSC_KEY_PASSWORD。')
  }
  return { source: certificateLink ? 'file' : 'store' }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    validateWindowsReleaseEnvironment()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
