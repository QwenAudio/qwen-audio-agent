# Using the Hugging Face speech-to-speech Frontend

qwen-audio-agent can also connect to a self-hosted
[Hugging Face speech-to-speech](https://github.com/huggingface/speech-to-speech).
It combines VAD, STT, LLM, and TTS into an OpenAI Realtime compatible service. The entire
voice pipeline can run fully locally, or you can swap out individual models or services
as needed. The Gateway only connects to the Realtime interface and does not modify the
STT, LLM, TTS, or voice configuration of speech-to-speech.

## Installing speech-to-speech

```bash
pip install "speech-to-speech[paraformer]"
```

## Starting the Service

Linux / Windows (NVIDIA GPU):

```bash
speech-to-speech \
  --stt paraformer \
  --llm_backend transformers \
  --device cuda
```

Apple Silicon:

```bash
speech-to-speech \
  --stt paraformer \
  --llm_backend mlx-lm \
  --device mps
```

The service runs at `ws://127.0.0.1:8765/v1/realtime` by default. Without an NVIDIA GPU,
you can also choose smaller CPU-friendly local models; the LLM can point to a locally
running vLLM / llama.cpp, or to cloud models such as Bailian via an OpenAI-compatible
endpoint. See the official speech-to-speech documentation for specific parameters.

## Connecting to qwen-audio-agent

Set the following in `config.env`:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=speech-to-speech
SPEECH_TO_SPEECH_REALTIME_URL=ws://127.0.0.1:8765/v1/realtime
```

In full-local mode, no cloud API Key is required. If the Realtime interface sits behind a
proxy that requires Bearer authentication, you can set:

```dotenv
SPEECH_TO_SPEECH_AUTH_TOKEN=your-token
```

`SPEECH_TO_SPEECH_AUTH_TOKEN` is only used for proxy authentication and is not an access
password for the local service.
