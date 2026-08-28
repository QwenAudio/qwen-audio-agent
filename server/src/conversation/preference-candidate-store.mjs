// 候选池的持久化 store。
//
// 晋升要求「跨 ≥2 个会话」的证据，纯内存实现会在进程重启时清零，跨会话证据
// 永远攒不满 —— 晋升机制事实上不生效。这个 store 让候选池能穿越重启。
//
// 落盘细节（原子写、损坏隔离、mtime + 哈希双重检测）全部在 JsonSnapshotStore
// 里，这里只声明「我是哪份数据、什么版本、快照该长什么样」。
//
// v2：槽位模型（field/value/confirm）取代了 v1 的自由文本 trait + 计数模型。
// 版本号必须跟着升，否则 v1 文件会被当成 v2 解析、逐条校验失败、静默变成空池。

import { JsonSnapshotStore } from '../core/json-snapshot-store.mjs'

const FILE_VERSION = 2
const MAX_OWNERS = 200

// 候选池只需要 store 提供 load/save/health/警告回调这四件事。
// 内部数据模型对 store 是不透明的：serialise/deserialise 由候选池自己做。
// 约定的快照形状：
//   { version, owners: { [ownerId]: [slot, ...] },
//     blocklist: { [ownerId]: [key, ...] } }
export class PreferenceCandidateStore extends JsonSnapshotStore {
  constructor({
    filePath = null,
    now = () => Date.now(),
    onWarning = warning => console.warn(warning.message),
    maxOwners = MAX_OWNERS,
  } = {}) {
    super({
      filePath,
      fileVersion: FILE_VERSION,
      label: '候选池',
      requiredKeys: ['owners'],
      now,
      onWarning,
    })
    this.maxOwners = maxOwners
  }
}
