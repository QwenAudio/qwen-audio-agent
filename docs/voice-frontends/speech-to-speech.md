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

The Chinese profile below relies on CJK punctuation and Qwen3-TTS long-utterance budgeting
fixes merged after v0.2.12. Until a release containing them is available, install the merged
revision directly:

```bash
pip install "speech-to-speech[paraformer] @ git+https://github.com/huggingface/speech-to-speech.git@f75d6b435d89b8dff911f639672c172166595409"
```

## Starting the Service

Linux / Windows (NVIDIA GPU):

```bash
speech-to-speech \
  --stt paraformer \
  --llm_backend transformers \
  --device cuda
```

For the tested Chinese Qwen3-TTS profile, use explicit model, language, speaker, and delivery
settings while keeping the backend sampling defaults:

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

The merged speech-to-speech fix preserves Chinese punctuation and scales the Qwen3-TTS codec
token budget for CJK text automatically. No sampling override or larger fixed token limit is
needed.

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
QWEN_AUDIO_REALTIME_URL=ws://127.0.0.1:8765/v1/realtime
QWEN_AUDIO_REALTIME_API_KEY=
QWEN_AUDIO_REALTIME_MODEL=
QWEN_AUDIO_REALTIME_VOICE=
```

In full-local mode, no cloud API Key is required. If the Realtime interface sits behind a
proxy that requires Bearer authentication, you can set:

```dotenv
QWEN_AUDIO_REALTIME_API_KEY=your-token
```

The model and voice are configured in speech-to-speech, not the Gateway. The optional
`QWEN_AUDIO_REALTIME_API_KEY` is sent as a Bearer token; setting it does not enable
authentication on an otherwise unprotected local service.
