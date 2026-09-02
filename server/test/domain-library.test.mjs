import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import test from 'node:test'
import {
  DOMAIN_LIMITS,
  DomainImportError,
  DomainLibrary,
  classifySource,
} from '../src/domain/domain-library.mjs'

const OWNER = 'user_personal'
const NOW = Date.parse('2026-08-26T09:00:00Z')

// 每个用例一套独立目录：source 放用户原始文件，docs 是资料库落盘目录
function withDirs(run) {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-domain-'))
  try {
    const source = join(root, 'source')
    const docs = join(root, 'workspace', 'domain')
    writeFileSync(join(root, '.keep'), '')
    return run({ root, source, docs })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function sourceFile(root, name, content = '# 手册\n\n## 第一节\n内容\n') {
  const path = join(root, name)
  writeFileSync(path, content)
  return path
}

function library({ docs, root, ...rest } = {}) {
  return new DomainLibrary({
    documentDirectory: docs,
    indexPath: root ? join(root, 'domain-index.json') : null,
    now: () => NOW,
    onWarning: () => {},
    ...rest,
  })
}

test('imports a local file into the shared workspace and returns its path', () => {
  withDirs(({ root, docs }) => {
    const source = sourceFile(root, '信用卡手册.md')
    const entry = library({ docs, root }).import({ ownerId: OWNER, sourcePath: source })
    assert.equal(entry.filename, '信用卡手册.md')
    assert.equal(entry.path, join(docs, '信用卡手册.md'))
    assert.equal(entry.source, source)
    assert.ok(entry.bytes > 0)
    // 落盘位置必须真的有这份文件 —— 后端就是拿这个路径去读的
    assert.match(readFileSync(entry.path, 'utf8'), /第一节/)
  })
})

test('survives a restart through the index file', () => {
  withDirs(({ root, docs }) => {
    const source = sourceFile(root, '手册.md')
    library({ docs, root }).import({ ownerId: OWNER, sourcePath: source })
    const restored = library({ docs, root }).list(OWNER)
    assert.equal(restored.length, 1)
    assert.equal(restored[0].filename, '手册.md')
  })
})

test('re-importing the same file updates in place instead of piling up', () => {
  withDirs(({ root, docs }) => {
    const source = sourceFile(root, '手册.md')
    const first = library({ docs, root }).import({ ownerId: OWNER, sourcePath: source })

    // 用户更新了手册再导一次 —— 常见操作，不该变成两条
    writeFileSync(source, '# 手册 v2\n\n## 新的一节\n内容\n')
    const shelf = library({ docs, root })
    const second = shelf.import({ ownerId: OWNER, sourcePath: source })
    assert.equal(shelf.list(OWNER).length, 1)
    assert.equal(second.id, first.id)
    assert.equal(second.filename, first.filename)
    assert.match(readFileSync(second.path, 'utf8'), /新的一节/)
  })
})

test('re-importing after a restart still recognises the same file', () => {
  withDirs(({ root, docs }) => {
    const source = sourceFile(root, '手册.md')
    library({ docs, root }).import({ ownerId: OWNER, sourcePath: source })
    // fingerprint 必须跟着索引存回来，否则重启后会把同一份手册再收一遍
    const shelf = library({ docs, root })
    shelf.import({ ownerId: OWNER, sourcePath: source })
    assert.equal(shelf.list(OWNER).length, 1)
  })
})

test('drops the summary when the content changed', () => {
  withDirs(({ root, docs }) => {
    const source = sourceFile(root, '手册.md')
    const shelf = library({ docs, root })
    const entry = shelf.import({ ownerId: OWNER, sourcePath: source })
    shelf.attachSummary({
      ownerId: OWNER,
      id: entry.id,
      title: '旧标题',
      gist: '旧说明',
      sections: ['旧章节'],
    })
    assert.equal(shelf.get(OWNER, entry.id).summarised, true)

    writeFileSync(source, '# 完全不同的内容\n')
    const reimported = shelf.import({ ownerId: OWNER, sourcePath: source })
    // 内容变了就得重新摘要，否则清单会一直描述旧版本
    assert.equal(reimported.summarised, false)
  })
})

test('keeps two different files that share a name apart', () => {
  withDirs(({ root, docs }) => {
    // 用户从两个不同目录各导入一份都叫「手册.md」的文件
    const dirA = join(root, 'a')
    const dirB = join(root, 'b')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    const first = join(dirA, '手册.md')
    const second = join(dirB, '手册.md')
    writeFileSync(first, '# 甲的手册\n')
    writeFileSync(second, '# 乙的手册\n')

    const shelf = library({ docs, root })
    const one = shelf.import({ ownerId: OWNER, sourcePath: first })
    const two = shelf.import({ ownerId: OWNER, sourcePath: second })

    assert.equal(shelf.list(OWNER).length, 2)
    assert.equal(one.filename, '手册.md')
    assert.equal(two.filename, '手册-2.md', '同名的第二份要自动错开')
    // 关键：后落盘的不能把先落盘的覆盖掉
    assert.match(readFileSync(one.path, 'utf8'), /甲的手册/)
    assert.match(readFileSync(two.path, 'utf8'), /乙的手册/)
  })
})

test('rejects what it cannot handle', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    const reject = (sourcePath, code) => {
      assert.throws(
        () => shelf.import({ ownerId: OWNER, sourcePath }),
        error => error instanceof DomainImportError && error.code === code,
        `${sourcePath} 应当以 ${code} 被拒`,
      )
    }
    reject(join(root, '不存在.md'), 'not_found')
    reject(root, 'not_a_file')

    const empty = join(root, '空.md')
    writeFileSync(empty, '')
    reject(empty, 'empty_file')

    // 真正不支持的：既不是文本，也不是能提取文字的文档
    const image = join(root, '照片.png')
    writeFileSync(image, 'not really a png')
    reject(image, 'unsupported_type')

    assert.throws(
      () => shelf.import({ ownerId: '', sourcePath: sourceFile(root, 'x.md') }),
      error => error.code === 'missing_owner',
    )
  })
})

test('rejects a file over the size limit', () => {
  withDirs(({ root, docs }) => {
    const big = join(root, '大手册.md')
    writeFileSync(big, 'x'.repeat(400))
    assert.throws(
      () => library({ docs, root, maxFileBytes: 100 })
        .import({ ownerId: OWNER, sourcePath: big }),
      error => error instanceof DomainImportError && error.code === 'too_large',
    )
  })
})

// 路径校验必须在 resolve 之前拦掉空输入：resolve('') 返回进程 cwd，那是个存在的
// 目录，会一路走到 statSync 才因为「不是文件」被拒 —— 用户看到的错误码就对不上
// 他实际做错的事。
test('rejects an empty path with invalid_path rather than not_a_file', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    for (const input of ['', '   ', null, undefined]) {
      assert.throws(
        () => shelf.import({ ownerId: OWNER, sourcePath: input }),
        error => error instanceof DomainImportError && error.code === 'invalid_path',
        `输入 ${JSON.stringify(input)} 应当报 invalid_path`,
      )
    }
  })
})

// 根目录判断用 parse().root 而不是写死 '/'。Windows 的根是 'C:\' 或
// '\\server\share\'，写死斜杠在那边一个都拦不住。这里直接对着 path.win32
// 验证判据本身 —— 在 POSIX 机器上跑 import() 无法复现 Windows 的路径语义。
test('recognises a filesystem root on both path flavours', () => {
  const isRoot = (impl, input) => {
    const absolute = impl.resolve(input)
    return absolute === impl.parse(absolute).root
  }
  // Windows：两种根都要认出来
  assert.equal(isRoot(win32, 'C:\\'), true)
  assert.equal(isRoot(win32, '\\\\server\\share'), true)
  assert.equal(isRoot(win32, 'C:\\Users\\me\\manual.pdf'), false)
  // POSIX：行为不变
  assert.equal(isRoot(posix, '/'), true)
  assert.equal(isRoot(posix, '/tmp/manual.pdf'), false)
  // 写死 '/' 的旧判据放行了 Windows 的根 —— 这条固定住为什么必须改
  assert.equal(win32.resolve('C:\\') === '/', false)
})

test('reports a clear error when no document directory is configured', () => {
  assert.throws(
    () => new DomainLibrary().import({ ownerId: OWNER, sourcePath: '/tmp/x.md' }),
    error => error instanceof DomainImportError && error.code === 'library_unavailable',
  )
})

test('attaches a summary and caps its fields', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    const entry = shelf.import({
      ownerId: OWNER,
      sourcePath: sourceFile(root, '手册.md'),
    })
    const updated = shelf.attachSummary({
      ownerId: OWNER,
      id: entry.id,
      title: '标'.repeat(200),
      gist: '说'.repeat(200),
      sections: Array.from({ length: 30 }, (_, index) => `第 ${index} 节`),
    })
    assert.equal([...updated.title].length, DOMAIN_LIMITS.MAX_TITLE_CHARS)
    assert.equal([...updated.gist].length, DOMAIN_LIMITS.MAX_GIST_CHARS)
    assert.equal(updated.sections.length, DOMAIN_LIMITS.MAX_SECTIONS)
    assert.equal(updated.summarised, true)
  })
})

test('finds a document by title, section or gist', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    const entry = shelf.import({
      ownerId: OWNER,
      sourcePath: sourceFile(root, 'credit.md'),
    })
    shelf.attachSummary({
      ownerId: OWNER,
      id: entry.id,
      title: '信用卡业务手册',
      gist: '覆盖开卡、年费、挂失四类流程',
      sections: ['年费规则', '挂失与补办'],
    })
    for (const keyword of ['信用卡', '年费规则', '挂失', 'credit']) {
      assert.equal(
        shelf.search({ ownerId: OWNER, keyword }).length,
        1,
        `关键词「${keyword}」应当命中`,
      )
    }
    assert.deepEqual(shelf.search({ ownerId: OWNER, keyword: '房贷' }), [])
  })
})

test('ranks a title hit above a section hit above a gist-only hit', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    const add = (name, summary) => {
      const entry = shelf.import({
        ownerId: OWNER,
        sourcePath: sourceFile(root, name, `# ${name}\n`),
      })
      shelf.attachSummary({ ownerId: OWNER, id: entry.id, ...summary })
      return entry
    }
    add('a.md', { title: '甲册', gist: '提到年费', sections: [] })
    add('b.md', { title: '乙册', gist: '无关', sections: ['年费规则'] })
    add('c.md', { title: '年费专册', gist: '无关', sections: [] })
    assert.deepEqual(
      shelf.search({ ownerId: OWNER, keyword: '年费' }).map(item => item.title),
      ['年费专册', '乙册', '甲册'],
    )
  })
})

test('keeps owners apart', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    shelf.import({ ownerId: 'a', sourcePath: sourceFile(root, 'a.md', '# 甲\n') })
    shelf.import({ ownerId: 'b', sourcePath: sourceFile(root, 'b.md', '# 乙\n') })
    assert.equal(shelf.list('a').length, 1)
    assert.equal(shelf.list('b').length, 1)
    assert.notEqual(shelf.list('a')[0].filename, shelf.list('b')[0].filename)
  })
})

test('removing a document deletes the copied file too', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    const entry = shelf.import({
      ownerId: OWNER,
      sourcePath: sourceFile(root, '手册.md'),
    })
    const removed = shelf.remove({ ownerId: OWNER, id: entry.id })
    assert.equal(removed.id, entry.id)
    assert.equal(shelf.list(OWNER).length, 0)
    assert.throws(() => readFileSync(entry.path), /ENOENT/)
    // 用户原始文件绝不能被碰
    assert.ok(readFileSync(entry.source, 'utf8'))
    assert.equal(shelf.remove({ ownerId: OWNER, id: entry.id }), null)
  })
})

test('caps the entry count per owner but never deletes the files', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root, maxPerOwner: 2 })
    const paths = []
    for (const name of ['a.md', 'b.md', 'c.md']) {
      const entry = shelf.import({
        ownerId: OWNER,
        sourcePath: sourceFile(root, name, `# ${name}\n`),
      })
      paths.push(entry.path)
    }
    assert.equal(shelf.list(OWNER).length, 2)
    // 容量回收只丢索引：用户的文件不该被一次静默的清理删掉
    for (const path of paths) assert.ok(readFileSync(path, 'utf8'))
  })
})

test('readHead refuses a file that is actually binary', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    const source = join(root, '伪装.md')
    writeFileSync(source, Buffer.from([0x23, 0x20, 0x00, 0x01, 0x02]))
    const entry = shelf.import({ ownerId: OWNER, sourcePath: source })
    // 扩展名骗了我们，NUL 字节说明这其实是二进制
    assert.equal(shelf.readHead(entry, 100), '')
  })
})

test('readHead only reads the requested prefix', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    const entry = shelf.import({
      ownerId: OWNER,
      sourcePath: sourceFile(root, '长文.md', '一'.repeat(500)),
    })
    assert.equal([...shelf.readHead(entry, 50)].length, 50)
  })
})

test('pendingSummary lists only the documents still lacking one', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    const first = shelf.import({
      ownerId: OWNER,
      sourcePath: sourceFile(root, 'a.md', '# 甲\n'),
    })
    shelf.import({ ownerId: OWNER, sourcePath: sourceFile(root, 'b.md', '# 乙\n') })
    shelf.attachSummary({ ownerId: OWNER, id: first.id, title: '甲册', gist: '说明' })
    assert.deepEqual(
      shelf.pendingSummary(OWNER).map(item => item.filename),
      ['b.md'],
    )
  })
})

test('works with no index file at all', () => {
  withDirs(({ docs, root }) => {
    const shelf = library({ docs })
    const entry = shelf.import({
      ownerId: OWNER,
      sourcePath: sourceFile(root, '手册.md'),
    })
    assert.ok(entry.path)
    assert.equal(shelf.list(OWNER).length, 1)
    assert.equal(shelf.health().persistenceEnabled, false)
    assert.equal(shelf.health().configured, true)
  })
})

test('sanitises a hand-edited index instead of trusting it', () => {
  withDirs(({ root, docs }) => {
    const indexPath = join(root, 'domain-index.json')
    writeFileSync(indexPath, JSON.stringify({
      version: 1,
      owners: {
        [OWNER]: [
          { id: 'ok', path: join(docs, 'a.md'), filename: 'a.md', title: '甲册' },
          { id: '', path: join(docs, 'b.md'), filename: 'b.md' },
          { id: 'no-path', filename: 'c.md' },
          'not-an-object',
        ],
      },
    }))
    const restored = library({ docs, root }).list(OWNER)
    assert.deepEqual(restored.map(item => item.id), ['ok'])
  })
})

// PDF / Word 不直接收，但也不是「不支持」—— 它们要先交给后端提取文字。
test('classifies a source into text, convertible or unsupported', () => {
  for (const name of ['a.md', 'a.TXT', 'a.csv', 'a.html']) {
    assert.equal(classifySource(name), 'text', name)
  }
  for (const name of ['a.pdf', 'a.PDF', 'a.docx', 'a.pptx', 'a.epub']) {
    assert.equal(classifySource(name), 'convertible', name)
  }
  // 图片音视频不属于「提取文字」，含糊派出去只会拿回一段模型编的描述
  for (const name of ['a.png', 'a.mp4', 'a.zip', 'a', '']) {
    assert.equal(classifySource(name), 'unsupported', name)
  }
})

test('tells a convertible file apart from an unsupported one when importing', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    const pdf = join(root, '手册.pdf')
    writeFileSync(pdf, '%PDF-1.7 fake')
    assert.throws(
      () => shelf.import({ ownerId: OWNER, sourcePath: pdf }),
      error => error.code === 'needs_conversion',
      'PDF 应当被识别为「需要转换」而不是「不支持」',
    )

    const png = join(root, '图.png')
    writeFileSync(png, 'not really a png')
    assert.throws(
      () => shelf.import({ ownerId: OWNER, sourcePath: png }),
      error => error.code === 'unsupported_type',
    )
  })
})

test('allocates a markdown target for a convertible file without creating it', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    const target = shelf.conversionTarget({
      ownerId: OWNER,
      sourcePath: join(root, '信用卡手册.pdf'),
    })
    assert.equal(target.filename, '信用卡手册.md')
    assert.equal(target.path, join(docs, '信用卡手册.md'))
    // 只是取名字：后端可能转失败，留一个空文件比什么都没有更糟
    assert.throws(() => readFileSync(target.path), /ENOENT/)
  })
})

test('a conversion target never collides with an existing document', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    shelf.import({ ownerId: OWNER, sourcePath: sourceFile(root, '手册.md', '# 已有\n') })
    const target = shelf.conversionTarget({
      ownerId: OWNER,
      sourcePath: join(root, 'elsewhere', '手册.pdf'),
    })
    assert.equal(target.filename, '手册-2.md', '不能覆盖已收录的同名文档')
  })
})

test('refuses to allocate a target for something not convertible', () => {
  withDirs(({ root, docs }) => {
    const shelf = library({ docs, root })
    for (const name of ['已经是文本.md', '图.png']) {
      assert.throws(
        () => shelf.conversionTarget({ ownerId: OWNER, sourcePath: join(root, name) }),
        error => error.code === 'not_convertible',
        name,
      )
    }
  })
})
