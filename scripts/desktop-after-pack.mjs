import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// extraResources excludes its sources from app.asar, even if `files` includes
// them. This shared module is needed both inside the app and by external
// backend launchers, so copy the external instance after packing, before signing.
export default async function afterPack({ appOutDir, packager }) {
  const target = join(packager.getResourcesDir(appOutDir), 'runtime/shared/runtime-paths.mjs')
  await mkdir(dirname(target), { recursive: true })
  await copyFile(join(packager.projectDir, 'shared/runtime-paths.mjs'), target)
}
