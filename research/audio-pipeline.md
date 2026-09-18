# Audio Pipeline

SOURCE-CONFIRMED local implementation:

- `AudioFeeder` decodes sources using ffmpeg.
- Output format is `f32le`.
- Channel count, sample rate, and frames per chunk come from WASM `initCaptureDriverJS`.
- Current expected common values are 16 kHz, mono, 320 frames per chunk, but the implementation uses the actual WASM callback values.
- Chunks are paced by `framesPerChunk / sampleRate`.
- `sendAudioData()` copies Float32 samples into WASM heap and calls `onAudioDataFromJs(ptr, sampleCount)`.

Patch:

- Added `ffmpeg-static` fallback.
- `FFMPEG_PATH` can override the binary.
- `call.play(path)` switches the current feeder to the provided MP3/WAV source after connection.

Do not send MP3 bytes directly. MP3 must be decoded/resampled to Float32 PCM before entering WASM.

