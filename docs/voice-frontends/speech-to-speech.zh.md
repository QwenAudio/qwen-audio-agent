# 使用 Hugging Face speech-to-speech 前台

qwen-audio-agent 也可以连接用户自行运行的
[Hugging Face speech-to-speech](https://github.com/huggingface/speech-to-speech)。
它将 VAD、STT、LLM 和 TTS 组合成 OpenAI Realtime 兼容服务，整条语音链路既可以
完全运行在本地，也可以按需替换其中的模型或服务。Gateway 只连接 Realtime 接口，
不会修改 speech-to-speech 的 STT、LLM、TTS 或音色配置。

## 安装 speech-to-speech

```bash
pip install "speech-to-speech[paraformer]"
```

## 启动服务

Linux / Windows（NVIDIA GPU）：

```bash
speech-to-speech \
  --stt paraformer \
  --llm_backend transformers \
  --device cuda
```

Apple Silicon：

```bash
speech-to-speech \
  --stt paraformer \
  --llm_backend mlx-lm \
  --device mps
```

服务默认运行在 `ws://127.0.0.1:8765/v1/realtime`。没有 NVIDIA GPU 时，也可以
选择适合 CPU 的更小本地模型；LLM 还可以指向本机运行的 vLLM / llama.cpp，或通过
OpenAI 兼容端点指向百炼等云端模型。具体参数见 speech-to-speech 官方文档。

## 接入 qwen-audio-agent

在 `config.env` 中设置：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=speech-to-speech
SPEECH_TO_SPEECH_REALTIME_URL=ws://127.0.0.1:8765/v1/realtime
```

在全本地模式下无需云端 API Key。如果 Realtime 接口位于需要 Bearer 认证的代理
后方，可设置：

```dotenv
SPEECH_TO_SPEECH_AUTH_TOKEN=your-token
```

`SPEECH_TO_SPEECH_AUTH_TOKEN` 仅用于代理认证，不是本地服务的访问密码。
