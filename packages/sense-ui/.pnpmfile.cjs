// pnpm 11 在 --ignore-workspace 模式下不读 .npmrc / package.json#pnpm；
// 这里通过 pnpmfile 的 updateConfig 钩子把严格构建审批降级为警告
// （esbuild 的 postinstall 只是平台二进制校验，optional 依赖已提供二进制），
// 并关闭本包 lockfile（包独立安装，锁文件不入库）。
module.exports = {
  hooks: {
    updateConfig: (config) => ({
      ...config,
      strictDepBuilds: false,
      lockfile: false,
    }),
  },
}
