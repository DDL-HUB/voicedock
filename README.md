# VoiceDock · 网页朗读

**看不动了，就听吧。**

收藏夹里吃灰的长文、看到一半的博客、密密麻麻的在线文档，还有微信读书里舍不得放下的那一章。用 VoiceDock 选中一句，就能从那里开始听。声音读到哪，原文就亮到哪。想接着看时，抬眼就能找到进度。

VoiceDock 是一款开源的 Chrome / Edge 朗读扩展，装好就能用浏览器语音。听文章可以调速，听书可以定时停止。在支持的微信读书页面，还能自动翻页接着读。

[下载 Windows 候选版](https://github.com/DDL-HUB/voicedock/releases/tag/v1.1.0-rc.1) · [安装步骤](#安装和朗读) · [隐私说明](PRIVACY.md) · [MIT 授权](LICENSE)

## 你可以这样用

- **听网页文章** · 选中一段文字，右键朗读选区，或打开扩展从选区往后读。高亮跟随原页正文。
- **听微信读书** · 用「读」悬浮球控制朗读，支持双页顺序和自动翻页。使用 Flash 时可衔接跨页未完句。手动滚动时会暂缓自动跟随。
- **按自己的节奏听** · 自然段与逐句模式可切换。可以暂停、调速、调整段间停顿、定时停止，或把文字粘贴到独立朗读窗口。
- **选择语音** · 首次安装使用浏览器语音。需要自己的 CosyVoice Flash 音色时，可在 Windows 上连接百炼账号。

## 安装和朗读

1. 从 [发布页](https://github.com/DDL-HUB/voicedock/releases/tag/v1.1.0-rc.1) 下载 Windows 安装包并解压。
2. 打开 Chrome 或 Edge 的扩展管理页，开启「开发者模式」，点击「加载已解压的扩展程序」，选择解压目录里的 `extension` 文件夹。
3. 刷新已打开的阅读页。选中文字，在工具栏点 VoiceDock，再点「从这里往后读」。微信读书也可以直接用页面上的「读」按钮。

这是首个公开候选版，通过 GitHub 分发。浏览器语音的可用音色取决于系统与浏览器，微信读书续读效果取决于书页版式和加载情况。

## 连接自己的 Flash 音色

需要 Windows、Python 3.10 或更新版本，以及自己的阿里云百炼 API Key 和 CosyVoice v3.5 Flash 音色。

1. 双击 `setup-cloud.cmd`，输入 API Key。安装完成后复制窗口显示的本机连接码。
2. 双击 `start-cloud.cmd`，保持服务窗口运行。
3. 在 VoiceDock 设置里填写连接码，确认云端传输和计费说明。
4. 回到扩展，点「同步平台音色」，选一个音色试读。

使用 Flash 时，朗读文字通过本机服务发送至阿里云，合成由你的百炼账号计费。API Key 由 Windows 加密保存。扩展设置里可以切回浏览器语音或断开云端连接。数据保存和清理方式见 [隐私说明](PRIVACY.md)。

## 从源码构建

扩展使用 Manifest V3，弹窗由 React 和 esbuild 构建。可选的 Flash 服务使用 Python，在本机接收已配对扩展的请求。

```powershell
npm ci
npm test
npm run build
python -m pip install -r bridge/requirements.txt
python -m unittest discover -s bridge -q
python tools/package-release.py
```

需要 Node.js 20 或更新版本。构建后可直接加载 `extension/`。打包脚本按文件清单生成源码包、Windows 安装包、扩展 ZIP 和 SHA-256 校验文件。

在装有 Edge 的 Windows 电脑上，可安装 Playwright 后运行 `python test/browser-smoke.py`，从安装包验证首次安装、连接、播放和跨页续读。浏览器测试使用模拟语音。真实账号与书页的发布验收记录见 [发布检查清单](RELEASE_CHECKLIST.md)。

## 反馈与致谢

遇到问题可以在 [Issues](https://github.com/DDL-HUB/voicedock/issues) 说明浏览器、网页类型、朗读模式和复现步骤。提交前请移除 API Key、连接码和私人内容。

本项目基于 Nathan Watkins 的 VoiceDock，按 MIT 授权分发。原项目和依赖的版权信息见 [第三方授权](THIRD_PARTY.md)。
