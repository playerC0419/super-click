# 研途 Windows 桌面版

本目录是独立桌面应用，不修改原 Sites 项目或其发布状态。

## 构建

使用 Node.js 22.12+，运行 `npm ci`、`node node_modules/electron/install.js`，再运行 `npm run dist`。Electron 44+ 的安装脚本需显式调用。package-lock.json 锁定版本。

依赖镜像可按网络状况设置 ELECTRON_MIRROR 和 ELECTRON_BUILDER_BINARIES_MIRROR；请保留上游校验和验证。若已有本地 Electron 分发，可向 electron-builder 指定 `--config.electronDist=node_modules/electron/dist`。

输出目录：../../outputs/masters_timeline/desktop-build 。安装包为 Yantu-Setup-1.0.0-win-x64.exe。

`prepare.cjs` 从原网站 dist 复制通用资源，仅调整桌面分享说明、标题和标记，不读取浏览器个人数据。`main.cjs` 使用固定 yantu://planner 来源、独立 userData、限制导航和 Node 权限。快照保存在用户目录，最近 10 份。

## 检验

在工作区根目录执行 `node research_planning/test_desktop.mjs`；设置 YANTU_PACKAGED_EXE 可测试打包后的程序。测试使用独立 YANTU_TEST_USER_DATA 目录，不操作日常数据；YANTU_TEST_HEADLESS 隐藏测试窗口。

当前已验证打包后程序的离线页面、JSON 原生下载/导入、正常关闭自动备份与重启保存。安装包另经 7-Zip 内容完整性检查。尚未在干净的其他 Windows 电脑执行完整安装流程，也未做代码签名。工具下载遇到缓存目录重命名暂态错误时，先确认文件提取完整后再恢复构建；repair-build-cache.cjs 仅针对本次缓存路径，非通用构建步骤。

升级时保持 appId、协议来源与 userData 目录；否则需人工导出、导入 JSON。日程数据不会自动从互联网更新。
