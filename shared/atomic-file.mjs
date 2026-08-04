export async function writeFileAtomic(
  targetPath,
  content,
  {
    fs,
    mode = 0o600,
    randomSuffix = () => `${process.pid}-${Date.now()}`,
  } = {},
) {
  const adapter = fs ?? await import('node:fs/promises')
  const tempPath = `${targetPath}.tmp-${randomSuffix()}`
  try {
    await adapter.writeFile(tempPath, content, {
      encoding: 'utf8',
      mode,
    })
    await adapter.rename(tempPath, targetPath)
  } catch (error) {
    await adapter.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}
