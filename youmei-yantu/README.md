# 优酶研途

玩家C出品。当前版本 1.0.2，启动页约两秒（含淡出）。

## 下载与使用

在 [GitHub Release](https://github.com/playerC0419/super-click/releases/tag/youmei-yantu-v1.0.2) 下载 Windows x64 EXE 或 Android APK。iPhone 提供待部署的主屏幕版 ZIP，没有直接安装的 IPA。微信传输若将后缀改为 `.apk.1`，请在文件管理中重命名为 `.apk`。

升级前导出 JSON，关闭旧版后覆盖安装。安卓不要先卸载。电脑和手机数据各自保存在本机，跨设备请导出/导入 JSON。

## 源码与构建

- `mobile/graduate-planner`：Capacitor Android/iOS 工程、原始通用模板 `base`、可部署静态网页 `pwa` 及共用启动页。详见该目录 README。
- `desktop/graduate-planner`：Electron Windows 工程，使用同级 mobile 中的模板及启动页。
- `docs`：使用说明、更新说明与规划建议。

需要 Node.js 22.12+。先分别在两个工程目录执行 `npm ci`。

安卓：安装 JDK 21、Android SDK 36 和 Build Tools 36，设置本机 SDK 路径，执行 `node prepare.cjs`、`npx cap sync android`，再在 android 目录运行 `gradlew assembleRelease`。发布包需签名；原发布私钥没有上传，自行生成的密钥无法覆盖原签名版本。

Windows：在 desktop/graduate-planner 执行 `npm run dist`，产物默认输出到项目下 outputs/masters_timeline/desktop-build。

网页：部署 `mobile/graduate-planner/pwa` 到 HTTPS 静态主机。主屏幕包在本地 Chromium 模拟中验证过，真实 Safari 离线使用仍需验证。

## 验证与范围

Windows 打包程序启动页实测约 2.04 秒；名称、版本、44 个节点与内嵌文件核对通过。安卓 APK 签名、对齐及资源一致性校验通过，尚未完成实体手机分享/打印验收。Windows 未做商业代码签名。具体报名、培养节点请核对当年学院与主办方通知。

项目未包含个人规划数据、签名私钥、凭据及构建缓存。第三方组件许可随源码或依赖保留；本次未额外授予项目开源许可证。
