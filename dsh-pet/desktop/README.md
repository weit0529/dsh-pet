# dsh-pet-desktop

这是 `dsh-pet` 的可选 Windows 桌面伴生组件。它不能脱离 DeepSeek Harness Host 单独工作；Host 停止时桌宠窗口也会退出。

开发运行：

1. 在本目录执行 `npm install`。
2. 回到 DSH 设置页勾选“启用桌面显示”。Host 会自动发现本目录的 Electron 运行时并启动。

生成 Windows 压缩包：执行 `npm run dist:win`，将 `dist/dsh-pet-desktop-win-x64.zip` 直接解压到：

`$DSH_HOME/dsh-pet/desktop/`（其中应包含 `dsh-pet-desktop.exe` 与 `resources/`）

也可以通过环境变量 `DSH_PET_DESKTOP_PATH` 指向该程序。桌面进程只接受 Host 启动时生成的短期令牌，并仅连接 `127.0.0.1`。

拖拽和自动漫游使用整个 Windows 可用桌面区域（保留任务栏）。透明画布可以伸出屏幕，但可见的宠物本体始终会被限制在屏幕内。
