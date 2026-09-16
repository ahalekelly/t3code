# Speech model attribution

The offline voice uses Pocket TTS model weights and the Alba voice embedding by Kyutai, licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). Model source: [kyutai/pocket-tts-without-voice-cloning](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning). The downloaded model files are unmodified.

The iOS inference runtime is [Pocket TTS iOS](https://github.com/UnaMentis/pocket-tts-ios), copyright 2026 UnaMentis and babybirdprd, licensed under MIT. Its license accompanies the runtime distribution. The runtime uses Candle, licensed under MIT or Apache 2.0, and SentencePiece, licensed under Apache 2.0.

Supertonic 3 model weights and the F1 voice style are by Supertone, licensed under [OpenRAIL-M](https://huggingface.co/supertone-oss-archive/supertonic-3/blob/main/LICENSE). The app uses [FluidInference’s Core ML conversion](https://huggingface.co/FluidInference/supertonic-3-coreml), with the INT4 Neural Engine vector estimator. [FluidAudio](https://github.com/FluidInference/FluidAudio) is licensed under Apache 2.0; its license is bundled with the app.
