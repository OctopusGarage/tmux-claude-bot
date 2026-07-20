# 本地语音翻译模式调研

Date: 2026-07-05
Status: 可行，建议先做轻量 MVP

## 问题

希望语音消息经过现有 Whisper 语音转文字后，中文内容能自动转成英文，再发送到 tmux 中的 Claude/Codex agent。

## 当前项目现状

- 文档只暴露了语音转写能力：语音消息会被自动转写为文本并发送给当前 session。
- `/voice_lang` 只设置识别语言，例如 `zh/en/yue/ja/es/auto`，不是翻译目标语言。
- Telegram 语音链路是 `transcribeWithCache()` -> 回显 `voiceHeard(transcribed)` -> `runPromptWithProgress(..., transcribed, ...)`。
- Lark/Feishu 语音链路是 `transcribeWithCache()` -> 回显 `voiceHeard(transcribed)` -> `enqueueLarkAction(..., "text", transcribed, ...)`。
- 代码和文档里没有发现现成的 translate/translation/translator 模式。

相关文件：

- `docs/agents/usage-guide.md`
- `docs/manual.md`
- `docs/commands.md`
- `src/core/read/transcriber.ts`
- `src/adapters/telegram/voice-handler.ts`
- `src/adapters/lark/voice.ts`
- `src/core/read/voice-support.ts`

## 候选方案

### 方案 A：直接用 Whisper 的英文翻译任务

Whisper 本身支持把非英文语音直接翻译成英文文本。OpenAI Whisper README 给出的 CLI 形式是：

```bash
whisper japanese.wav --model medium --language Japanese --task translate
```

优点：

- 不需要额外文本翻译模型。
- 与现有 `mlx_whisper` 链路最接近，只是在调用参数上增加 `--task translate`。
- 对“中文语音 -> 英文 prompt”这个单一需求最直接。

限制：

- 它是“音频直接到英文”，不是“先保留中文文本再把中文文本翻译成英文”。如果需要同时展示中文原文和英文发送文本，可能要跑两次，或改用方案 B。
- 当前项目默认模型是 `mlx-community/whisper-large-v3-turbo`。OpenAI Whisper README 明确说明 turbo 不适合 translation task，`--task translate` 可能仍返回原语言；应改用 `medium` 或 `large` 系列的多语言模型。
- `mlx_whisper --task translate --output-format srt` 在 2026-04 有一个公开 issue 报 `words` 字段问题；本项目用 `txt` 输出，风险较低，但实现时应专门 smoke test。

来源：

- OpenAI Whisper README: https://github.com/openai/whisper
- mlx-whisper PyPI: https://pypi.org/project/mlx-whisper/
- mlx-examples issue #1418: https://github.com/ml-explore/mlx-examples/issues/1418

### 方案 B：转写后接 Argos Translate

Argos Translate 是开源离线翻译库，支持 Python library、CLI、GUI，模型以 `.argosmodel` 包安装。官方包索引有 `Chinese -> English` 和 `Chinese (traditional) -> English` 包。

实测 HEAD 信息显示 `translate-zh_en-1_9.argosmodel` 下载体积约 74.5 MB。这个量级很适合“语音 prompt 翻译”这种短文本场景。

优点：

- 真正做“中文文本 -> 英文文本”，可同时回显中文原文和英文发送文本。
- 模型体积小，部署简单，适合 MVP。
- CLI/Python API 都能接入 Node 进程。

限制：

- 质量大概率低于更大的 NLLB/MADLAD 或商业翻译；对代码任务 prompt 通常够用，但复杂长句需要实测。
- 需要增加一个翻译安装脚本和运行时检查，类似当前 `install-whisper.sh`。

来源：

- Argos Translate GitHub: https://github.com/argosopentech/argos-translate
- Argos package index: https://www.argosopentech.com/argospm/index/
- argospm-index: https://github.com/argosopentech/argospm-index

### 方案 C：OPUS-MT / MarianMT `Helsinki-NLP/opus-mt-zh-en`

Hugging Face 上的 `Helsinki-NLP/opus-mt-zh-en` 是中文到英文的专用翻译模型，模型卡标注 Source Language 为 Chinese、Target Language 为 English，可用于 translation/text-to-text generation。主 PyTorch 权重约 312 MB。

优点：

- 方向明确，中文 -> 英文专用。
- 模型比 NLLB/M2M100 小很多，成熟度高。
- 可以用 Transformers 快速接入，也可以考虑 CTranslate2 优化。

限制：

- 比 Argos 重一些，Python 依赖也更重。
- 模型较老，口语化短 prompt 的实际质量需要样本测试。

来源：

- Model card: https://huggingface.co/Helsinki-NLP/opus-mt-zh-en
- Transformers Marian docs: https://huggingface.co/docs/transformers/en/model_doc/marian
- CTranslate2 Transformers support: https://opennmt.net/CTranslate2/guides/transformers.html

### 方案 D：NLLB / M2M100 / MADLAD

这些是更通用的多语言翻译模型：

- `facebook/nllb-200-distilled-600M`: 支持 200 语言，官方模型卡说主要是研究用、单句翻译，输入长度不超过 512 tokens；PyTorch 权重约 2.46 GB。
- `facebook/m2m100_418M`: 支持 100 语言的 many-to-many translation；PyTorch 权重约 1.94 GB。
- `google/madlad400-3b-mt`: 3B 级模型，不属于轻量方案。

结论：如果目标是手机语音短 prompt 的“轻量本地翻译”，这些不适合作为第一版。

来源：

- NLLB model card: https://huggingface.co/facebook/nllb-200-distilled-600M
- M2M100 model card: https://huggingface.co/facebook/m2m100_418M
- MADLAD model card: https://huggingface.co/google/madlad400-3b-mt
- CTranslate2 supported models: https://github.com/OpenNMT/CTranslate2

## 建议

推荐分两阶段：

1. MVP：加 `VOICE_TRANSLATE_MODE=off|whisper_en|argos_zh_en`。
   - `off` 保持当前行为。
   - `whisper_en`：在语音转写调用里切到 `--task translate`，并要求使用非 turbo 的 Whisper multilingual model。
   - `argos_zh_en`：保留中文转写文本，再用 Argos Translate 转英文后发送。
2. 默认先实现 `argos_zh_en` 作为“转写后翻译”的严格语义，保留 `whisper_en` 作为性能/简化路径。

实现切入点：

- 抽一个 `transformVoicePrompt(channel, transcribed)`。
- Telegram 和 Lark 都在发送前调用该 transform。
- 回显文案建议展示两行：识别原文 + 将发送英文，避免用户误以为中文原文直接进了 agent。
- 安装脚本建议仿照 `scripts/install-whisper.sh`，使用项目 `.venv` 安装 `argostranslate` 和 `translate-zh_en-1_9.argosmodel`。
- `doctor` 可以把翻译能力作为 optional check，类似 voice transcription。

## 结论

项目现在不支持轻量翻译模式，但现有语音链路很容易插入。若目标是“中文语音 -> 英文 prompt 发送给 tmux”，成熟可靠的本地轻量方案优先级是：

1. Argos Translate `zh -> en`：最适合 MVP，约 74.5 MB 模型包。
2. Whisper `--task translate`：无需额外翻译模型，但需要避开当前默认 turbo 模型，且语义是音频直译英文。
3. OPUS-MT `Helsinki-NLP/opus-mt-zh-en`：质量和可控性可能比 Argos 更好，约 312 MB 权重，适合作为第二档。
4. NLLB/M2M100/MADLAD：成熟但不轻量，不建议第一版。
