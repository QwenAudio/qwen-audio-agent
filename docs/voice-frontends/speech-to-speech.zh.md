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

下文的中文配置依赖 v0.2.12 之后合入的 CJK 标点与 Qwen3-TTS 长文本预算修复。
在包含这些修复的版本发布之前，请直接安装已合入的修订版本：

```bash
pip install "speech-to-speech[paraformer] @ git+https://github.com/huggingface/speech-to-speech.git@f75d6b435d89b8dff911f639672c172166595409"
```

## 启动服务

Linux / Windows（NVIDIA GPU）：

```bash
speech-to-speech \
  --stt paraformer \
  --llm_backend transformers \
  --device cuda
```

经过测试的中文 Qwen3-TTS 配置如下：显式指定模型、语言、说话人与表达指令，
采样参数保持后端默认值：

```bash
speech-to-speech \
  --stt paraformer \
  --llm_backend transformers \
  --model_name Qwen/Qwen3-4B-Instruct-2507 \
  --tts qwen3 \
  --qwen3_tts_backend torch \
  --qwen3_tts_model_name Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice \
  --qwen3_tts_speaker Vivian \
  --qwen3_tts_language chinese \
  --qwen3_tts_instruct "请用平稳、自然、克制的语气说话，保持均匀语速，避免夸张的音高变化，句末自然收束。" \
  --device cuda
```

已合入的 speech-to-speech 修复会保留中文标点，并为 CJK 文本自动放大
Qwen3-TTS codec token 预算，无需覆盖采样参数或设置更大的固定 token 上限。

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
