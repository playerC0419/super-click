# 优酶研途手机版

1.0.2 版本使用深蓝分子轨迹启动页，署名「玩家C出品」，展示约两秒（包含 500 毫秒淡出）。与电脑版共用 startup.html、startup.css、startup.js；初始化较慢时等待就绪后再退出。保留原包名、签名和数据键，Android versionCode 为 3。

优先交付 Android APK。iPhone 提供可添加到主屏幕的 PWA，并保留 Capacitor iOS 工程；当前 Windows 环境未编译或签名 iPhone IPA。

## 资源和构建

Node.js 22.12+。运行 `npm ci`，`node prepare.cjs`，`npx cap sync`。`base/` 是本次转换时保留的通用网页模板，更新网页内容时需明确更新该目录。`prepare.cjs` 不读取个人浏览器数据。

Android：JDK 21、Android SDK API 36、Build Tools 36、Gradle 8.14.3。工程含 Gradle Wrapper，执行 `cd android && ./gradlew assembleRelease` 可获得未签名 APK。Windows 当前路径包含中文，已配置 android.overridePathCheck；换构建机器时请重新设置本机 android/local.properties。项目使用国内 Maven 镜像优先、官方仓库回退。

本机 `sign-android.cjs` 生成并保留独立发布密钥，使用 zipalign 和 apksigner 输出可安装正式 APK。**signing/ 是私密更新凭证，不能公开或发给普通使用者；同一应用后续覆盖升级必须保留此密钥。** 用户数据不在密钥目录。签名脚本为当前 Windows 构建环境编写。

Android 原生打印通过本项目 YantuPrintPlugin 调用系统 PrintManager。JSON/CSV/ICS 写入应用缓存后由 Capacitor Share 打开系统分享，不请求公共存储读写权限。导入用系统文件选择器和网页校验。个人主数据写入 Preferences，并保留应用私有 JSON 恢复副本；卸载应用会清除这些数据，需定期导出到应用之外。

iOS：Mac + Xcode 26+，运行 `npx cap sync ios` 后打开 ios/App/App.xcodeproj。Swift Package Manager 会拉取原生依赖。已添加图标与 PrivacyInfo.xcprivacy（Preferences、Filesystem 的所用 API 理由），尚未在 Xcode 构建验证。原生 iOS 暂未接入打印；PWA 可使用 Safari 打印。没有账号/签名时，源码或模拟器 .app 不能直接安装到实体 iPhone。

`.github/workflows/mobile.yml` 可放在以本目录为根的 GitHub 仓库，用于云端 Android 调试包与 iOS 模拟器构建。工作流已准备但未上传或执行；模拟器产物不能安装到实体 iPhone。GitHub Actions 可提供 Mac 构建环境，不能替代 Apple 分发签名。

## PWA

`pwa/` 为可直接上传 Netlify 等 HTTPS 静态主机的目录；网站当前使用的来源不变时可保留原浏览器数据。含 manifest、图标、service worker、手机布局和系统文件分享。初次联网加载并完成离线准备后可离线重开。缓存更新等待旧版本所有窗口关闭，不会主动清除个人 localStorage。

## 验证范围

`research_planning/test_mobile.mjs` 在工作区根目录运行，需先启动本目录 preview.cjs。检验 Pixel/iPhone 尺寸下的 Chromium 触屏模拟、离线重载、指南页、JSON 数据迁移；文件分享由测试桩接收。该测试不代表 Safari、实体 Android 或实体 iPhone 已验收。

发布 APK 需额外用 apksigner verify 和 zipalign -c 校验。当前没有连接安卓测试设备，实体安装、厂商权限界面、系统文件分享及打印需在真实手机验收。

## GitHub 调研

- 跨端封装：https://github.com/ionic-team/capacitor
- 原生存储：https://github.com/ionic-team/capacitor-plugins/tree/main/preferences
- 文件存取：https://github.com/ionic-team/capacitor-filesystem
- 系统文件分享：https://github.com/ionic-team/capacitor-plugins/tree/main/share
- Android 安全区及旧 WebView 兼容：https://github.com/ionic-team/capacitor/blob/main/core/system-bars.md
- 打印方案参考：https://github.com/Cap-go/capacitor-printer 。当前仅用系统 PrintManager 实现本项目的 Android 当前页面打印，没有集成该第三方插件。
- 云端 Mac 镜像：https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md
- 免费 iPhone 安装方式（Apple）：https://support.apple.com/guide/iphone/iphea86e5236/ios
