import { managedOnlyBackend } from './shared.mjs'

export const kimiRuntimeDriver = {
  id: 'kimi',
  separateManagedProcess: false,

  resolve({ ownership, permissionMode }) {
    return managedOnlyBackend({
      id: this.id,
      ownership,
      permissionMode,
      label: 'Kimi Code',
    })
  },
}
