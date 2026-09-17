// 客服示例自己的 lint 配置。
//
// 【为什么要单独一份】
// 仓库根的 eslint.config.mjs 第 16 行显式忽略 `examples/**` —— 那是上游的决定，
// 我不去改它。于是 `npm run lint` 对这个目录零输出，而零输出【不等于通过】：
// 它压根没检。
//
// 这一份复用根配置的规则，只把 ignores 里的 examples 那条摘掉，
// 于是能真正检到本目录。跑法：
//
//   npx eslint . --config eslint.config.mjs        （在本目录下）
//   npm run lint --prefix examples/customer-service
//
// 根 package.json 里也挂了 example:customer-service:lint，和 smart-cockpit 对称。

import base from '../../eslint.config.mjs'

export default base
  .map((entry) => {
    if (!entry.ignores) return entry
    return {
      ...entry,
      // 摘掉 examples 那条 —— 留着的话这份配置和根配置一样什么都不检。
      // 其余忽略项（node_modules、dist）要保留。
      ignores: entry.ignores.filter(pattern => pattern !== 'examples/**'),
    }
  })
  .concat([
    {
      // 本目录额外要忽略的：运行时产物与抽取缓存。
      // 它们在 .gitignore 里也挡着，但 eslint 不读 .gitignore。
      ignores: [
        '.runtime/**',
        '.runtime-*/**',
        'console/.cache/**',
        'domains/*/db.backup.json',
      ],
    },
  ])
