import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import tar from 'tar-stream'
import unbzip2 from 'unbzip2-stream'

export const WAKE_WORD_MODEL_NAME = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20'
export const WAKE_WORD_MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${WAKE_WORD_MODEL_NAME}.tar.bz2`
export const WAKE_WORD_MODEL_SHA256 = '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6'

export const WAKE_WORD_MODEL_FILES = Object.freeze({
  encoder: 'encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx',
  decoder: 'decoder-epoch-13-avg-2-chunk-8-left-64.onnx',
  joiner: 'joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx',
  tokens: 'tokens.txt',
  keywords: 'keywords.txt',
})

const ARCHIVE_FILES = new Set([
  WAKE_WORD_MODEL_FILES.encoder,
  WAKE_WORD_MODEL_FILES.decoder,
  WAKE_WORD_MODEL_FILES.joiner,
  WAKE_WORD_MODEL_FILES.tokens,
])
const REQUIRED_FILES = new Set(Object.values(WAKE_WORD_MODEL_FILES))
const preparations = new Map()

function complete(directory) {
  return [...REQUIRED_FILES].every(file => existsSync(resolve(directory, file)))
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(url, path, fetchImpl) {
  const response = await fetchImpl(url)
  if (!response.ok || !response.body) {
    throw new Error(`唤醒词模型下载失败：HTTP ${response.status}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, {
    flags: 'wx',
    mode: 0o600,
  }))
}

async function extractSelected(archivePath, targetDirectory) {
  const extract = tar.extract()
  const writes = []
  extract.on('entry', (header, stream, next) => {
    const file = basename(header.name)
    if (header.type !== 'file' || !ARCHIVE_FILES.has(file)) {
      stream.resume()
      stream.on('end', next)
      return
    }
    const destination = resolve(targetDirectory, file)
    const write = pipeline(stream, createWriteStream(destination, {
      mode: 0o600,
    })).then(next, error => extract.destroy(error))
    writes.push(write)
  })
  await pipeline(createReadStream(archivePath), unbzip2(), extract)
  await Promise.all(writes)
}

async function prepare(directory, { fetchImpl }) {
  if (complete(directory)) return directory
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 })
  const nonce = `${process.pid}-${Date.now()}`
  const archivePath = resolve(dirname(directory), `${WAKE_WORD_MODEL_NAME}-${nonce}.tar.bz2`)
  const stagingDirectory = resolve(dirname(directory), `.${WAKE_WORD_MODEL_NAME}-${nonce}`)
  mkdirSync(stagingDirectory, { recursive: false, mode: 0o700 })
  try {
    await download(WAKE_WORD_MODEL_URL, archivePath, fetchImpl)
    const digest = await sha256(archivePath)
    if (digest !== WAKE_WORD_MODEL_SHA256) {
      throw new Error('唤醒词模型校验失败')
    }
    await extractSelected(archivePath, stagingDirectory)
    writeFileSync(
      resolve(stagingDirectory, WAKE_WORD_MODEL_FILES.keywords),
      'n ǐ h ǎo q iān w èn @你好千问\n',
      { encoding: 'utf8', mode: 0o600 },
    )
    if (!complete(stagingDirectory)) {
      throw new Error('唤醒词模型缺少必需文件')
    }
    rmSync(directory, { recursive: true, force: true })
    renameSync(stagingDirectory, directory)
    return directory
  } finally {
    rmSync(archivePath, { force: true })
    rmSync(stagingDirectory, { recursive: true, force: true })
  }
}

export function ensureWakeWordModel(directory, {
  fetchImpl = fetch,
} = {}) {
  const target = resolve(directory, WAKE_WORD_MODEL_NAME)
  if (complete(target)) return Promise.resolve(target)
  if (!preparations.has(target)) {
    const pending = prepare(target, { fetchImpl })
      .finally(() => preparations.delete(target))
    preparations.set(target, pending)
  }
  return preparations.get(target)
}
