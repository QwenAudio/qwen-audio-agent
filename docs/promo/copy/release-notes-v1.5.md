# v1.5.0 Release Notes 草稿（中英文）

## 中文

v1.5.0 带来了语音唤醒词、Linux 桌面版和一批体验改进。

### 新功能

- 语音唤醒词：桌面版空闲休眠后麦克风保持开启，说出唤醒词即可激活，
  检测全程本地运行（sherpa-onnx），休眠期间无任何云端调用
- 定时提醒与进度查询：可以口头设置提醒，随时询问任务进度
- Linux 桌面版打包：AppImage 与 deb 双格式

### 改进

- 桌面版与 CLI 数据目录隔离：两者可同时运行、互不干扰
- 后台任务完成或需要授权时，自动从休眠中唤醒并播报

## English

v1.5.0 brings voice wake word, Linux desktop builds, and a batch of
experience improvements.

### New

- Voice wake word: after the desktop app sleeps on idle, the mic stays
  open and a wake phrase brings it back. Detection runs fully locally
  (sherpa-onnx); no cloud calls while sleeping.
- Scheduled reminders and progress queries: set reminders by voice and
  ask about task progress any time.
- Linux desktop builds: AppImage and deb.

### Improved

- Desktop and CLI now use isolated data directories, so both can run
  side by side without interfering.
- The app now wakes automatically from sleep when a background task
  completes or needs your approval.
