# asi-speech-helper (native macOS STT)

Lightweight macOS Swift CLI helper for **雪儿 · ASI Presence** (`apps/asi-presence`), providing out-of-the-box Chinese/English speech recognition in standalone Electron macOS builds via Apple's `Speech` framework (`SFSpeechRecognizer` + `SFSpeechAudioBufferRecognitionRequest`).

## Design & Privacy Guarantees

- **100% In-Memory Audio**: Reads 16kHz RIFF/WAVE (or raw 16-bit signed LE mono PCM) directly from `stdin` into `AVAudioPCMBuffer` in RAM (16 MiB safety cap). Audio is **never written to disk**.
- **Zero Dialog Spam**: Inspects `SFSpeechRecognizer.authorizationStatus()` first. If `.denied` or `.restricted`, exits immediately with structured JSON (`code: "permission_denied"` / `"permission_restricted"`) without prompting. Only calls `requestAuthorization` when `--request-auth` is explicitly passed for `.notDetermined` (and `PresenceSttService` passes it at most once per app session).
- **Embedded Usage Description**: Links `Sources/ASISpeechHelper/Info.plist` into `__TEXT,__info_plist` during release builds so macOS TCC never aborts on `NSSpeechRecognitionUsageDescription`.
- **Structured JSON Output**: Emits a single JSON object line on `stdout`:
  ```json
  {"ok":true,"text":"雪儿早上好","locale":"zh-CN","onDevice":false,"authStatus":"authorized"}
  ```

## Build (macOS Apple Silicon `arm64`)

```bash
native/asi-speech-helper/scripts/build.sh
# Optional architecture override:
# native/asi-speech-helper/scripts/build.sh x86_64
```

The script compiles a release `arm64` binary and installs it to `apps/asi-presence/dist/main/asi-speech-helper`, which `PresenceSttService` discovers automatically. Running `pnpm --filter asi-presence build` on macOS also builds and copies this binary automatically when Swift CLT is installed.

## CLI Options

- `--locale <id>`: Recognition locale (default `zh-CN`)
- `--sample-rate <hz>`: Sample rate for raw PCM stdin without WAV header (default `16000`)
- `--timeout-ms <ms>`: Internal recognition timeout in milliseconds (`1000..60000`, default `12000`)
- `--on-device`: Require Apple on-device recognition model
- `--request-auth`: Allow a single OS authorization request if status is `.notDetermined`
- `--check`: Report authorization & recognizer availability as JSON without reading stdin
