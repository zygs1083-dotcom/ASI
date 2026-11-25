import AVFoundation
import Darwin
import Foundation
import Speech

private let maxStdinAudioBytes = 16 * 1024 * 1024 // 16 MiB (~8.5 minutes of 16kHz 16-bit mono PCM)
private let defaultLocaleId = "zh-CN"
private let defaultSampleRate = 16_000
private let defaultTimeoutMs = 12_000
private let authPromptTimeoutSec: TimeInterval = 15.0

private struct HelperError: Error, Sendable {
  let code: String
  let message: String
}

private struct HelperOutput: Encodable, Sendable {
  let ok: Bool
  let text: String
  let locale: String
  let onDevice: Bool
  let authStatus: String
  let code: String?
  let error: String?
}

private struct CliOptions: Sendable {
  var locale: String = defaultLocaleId
  var sampleRate: Int = defaultSampleRate
  var timeoutMs: Int = defaultTimeoutMs
  var requireOnDevice: Bool = false
  var requestAuth: Bool = false
  var checkOnly: Bool = false
}

private struct ParsedAudio: Sendable {
  let sampleRate: Int
  let channels: Int
  let bitsPerSample: Int
  let isFloat: Bool
  let pcmData: Data
}

private final class LockedRecognitionState: @unchecked Sendable {
  private let lock = NSLock()
  private var finished = false
  private var latestText = ""
  private var finalText: String?
  private var errorCode: String?
  private var errorMessage: String?

  func isFinished() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return finished
  }

  func recordPartial(_ text: String) {
    lock.lock()
    defer { lock.unlock() }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
      latestText = trimmed
    }
  }

  func completeSuccess(_ text: String) {
    lock.lock()
    defer { lock.unlock() }
    if finished { return }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    finalText = trimmed.isEmpty ? latestText : trimmed
    finished = true
  }

  func completeError(code: String, message: String) {
    lock.lock()
    defer { lock.unlock() }
    if finished { return }
    errorCode = code
    errorMessage = message
    finished = true
  }

  func snapshot() -> (finished: Bool, latestText: String, finalText: String?, errorCode: String?, errorMessage: String?) {
    lock.lock()
    defer { lock.unlock() }
    return (finished, latestText, finalText, errorCode, errorMessage)
  }
}

private final class LockedAuthState: @unchecked Sendable {
  private let lock = NSLock()
  private var status: SFSpeechRecognizerAuthorizationStatus?

  func set(_ next: SFSpeechRecognizerAuthorizationStatus) {
    lock.lock()
    defer { lock.unlock() }
    status = next
  }

  func get() -> SFSpeechRecognizerAuthorizationStatus? {
    lock.lock()
    defer { lock.unlock() }
    return status
  }
}

private func authStatusString(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch status {
  case .authorized:
    return "authorized"
  case .denied:
    return "denied"
  case .restricted:
    return "restricted"
  case .notDetermined:
    return "not_determined"
  @unknown default:
    return "unknown"
  }
}

private func emitAndExit(_ output: HelperOutput, exitCode: Int32) -> Never {
  let encoder = JSONEncoder()
  if var encoded = try? encoder.encode(output) {
    encoded.append(0x0A)
    try? FileHandle.standardOutput.write(contentsOf: encoded)
  } else {
    let fallback = "{\"ok\":false,\"text\":\"\",\"locale\":\"zh-CN\",\"onDevice\":false,\"authStatus\":\"unknown\",\"code\":\"encode_failed\",\"error\":\"Failed to encode JSON output\"}\n"
    if let data = fallback.data(using: .utf8) {
      try? FileHandle.standardOutput.write(contentsOf: data)
    }
  }
  exit(exitCode)
}

private func parseCliOptions(_ args: [String]) -> CliOptions {
  var opts = CliOptions()
  var idx = 1
  while idx < args.count {
    let arg = args[idx]
    switch arg {
    case "--locale":
      if idx + 1 < args.count {
        let val = args[idx + 1].trimmingCharacters(in: .whitespacesAndNewlines)
        if !val.isEmpty {
          opts.locale = val
        }
        idx += 2
      } else {
        idx += 1
      }
    case "--sample-rate":
      if idx + 1 < args.count, let parsed = Int(args[idx + 1]), parsed >= 8_000, parsed <= 48_000 {
        opts.sampleRate = parsed
        idx += 2
      } else {
        idx += 1
      }
    case "--timeout-ms":
      if idx + 1 < args.count, let parsed = Int(args[idx + 1]) {
        opts.timeoutMs = max(1_000, min(60_000, parsed))
        idx += 2
      } else {
        idx += 1
      }
    case "--on-device":
      opts.requireOnDevice = true
      idx += 1
    case "--request-auth":
      opts.requestAuth = true
      idx += 1
    case "--check":
      opts.checkOnly = true
      idx += 1
    default:
      idx += 1
    }
  }
  return opts
}

private func readUInt16LE(_ data: Data, at offset: Int) -> UInt16 {
  let base = data.startIndex + offset
  return UInt16(data[base]) | (UInt16(data[base + 1]) << 8)
}

private func readUInt32LE(_ data: Data, at offset: Int) -> UInt32 {
  let base = data.startIndex + offset
  return UInt32(data[base])
    | (UInt32(data[base + 1]) << 8)
    | (UInt32(data[base + 2]) << 16)
    | (UInt32(data[base + 3]) << 24)
}

private func readAscii4(_ data: Data, at offset: Int) -> String {
  let start = data.startIndex + offset
  let end = start + 4
  return String(bytes: data[start..<end], encoding: .ascii) ?? ""
}

private func readStdinAudioInMemory(maxBytes: Int) -> Result<Data, HelperError> {
  var buffer = Data()
  while true {
    do {
      guard let chunk = try FileHandle.standardInput.read(upToCount: 65_536), !chunk.isEmpty else {
        break
      }
      if buffer.count + chunk.count > maxBytes {
        return .failure(HelperError(code: "audio_too_large", message: "Input audio exceeds 16 MiB memory safety cap"))
      }
      buffer.append(chunk)
    } catch {
      return .failure(HelperError(code: "stdin_read_failed", message: "Failed to read stdin audio: \(error.localizedDescription)"))
    }
  }
  if buffer.isEmpty {
    return .failure(HelperError(code: "empty_audio", message: "No audio bytes received on stdin"))
  }
  return .success(buffer)
}

private func parseAudioBytes(_ raw: Data, fallbackSampleRate: Int) -> Result<ParsedAudio, HelperError> {
  // Detect RIFF/WAVE header in memory; otherwise interpret bytes as raw 16-bit signed LE mono PCM.
  if raw.count >= 12 && readAscii4(raw, at: 0) == "RIFF" && readAscii4(raw, at: 8) == "WAVE" {
    var offset = 12
    var audioFormat: UInt16 = 0
    var channels: Int = 0
    var sampleRate: Int = 0
    var bitsPerSample: Int = 0
    var pcmSlice: Data?

    while offset + 8 <= raw.count {
      let chunkId = readAscii4(raw, at: offset)
      let chunkSize = Int(readUInt32LE(raw, at: offset + 4))
      let payloadStart = offset + 8
      if payloadStart > raw.count {
        break
      }
      let payloadEnd = min(raw.count, payloadStart + max(0, chunkSize))

      if chunkId == "fmt " && payloadEnd - payloadStart >= 16 {
        audioFormat = readUInt16LE(raw, at: payloadStart)
        channels = Int(readUInt16LE(raw, at: payloadStart + 2))
        sampleRate = Int(readUInt32LE(raw, at: payloadStart + 4))
        bitsPerSample = Int(readUInt16LE(raw, at: payloadStart + 14))
      } else if chunkId == "data" {
        let start = raw.startIndex + payloadStart
        let end = raw.startIndex + payloadEnd
        pcmSlice = raw.subdata(in: start..<end)
      }

      // RIFF chunks are padded to even byte boundaries.
      let paddedSize = chunkSize + (chunkSize % 2)
      let nextOffset = payloadStart + paddedSize
      if nextOffset <= offset {
        break
      }
      offset = nextOffset
    }

    guard let pcmData = pcmSlice, !pcmData.isEmpty else {
      return .failure(HelperError(code: "invalid_wav", message: "WAV input is missing PCM data chunk"))
    }
    guard channels >= 1 && channels <= 2 else {
      return .failure(HelperError(code: "unsupported_audio_format", message: "Unsupported WAV channel count: \(channels)"))
    }
    guard sampleRate >= 8_000 && sampleRate <= 48_000 else {
      return .failure(HelperError(code: "unsupported_audio_format", message: "Unsupported WAV sample rate: \(sampleRate)"))
    }
    if audioFormat == 1 && bitsPerSample == 16 {
      if pcmData.count < 2 * channels {
        return .failure(HelperError(code: "empty_audio", message: "Decoded audio contains zero PCM frames"))
      }
      return .success(ParsedAudio(sampleRate: sampleRate, channels: channels, bitsPerSample: 16, isFloat: false, pcmData: pcmData))
    }
    if audioFormat == 3 && bitsPerSample == 32 {
      if pcmData.count < 4 * channels {
        return .failure(HelperError(code: "empty_audio", message: "Decoded audio contains zero PCM frames"))
      }
      return .success(ParsedAudio(sampleRate: sampleRate, channels: channels, bitsPerSample: 32, isFloat: true, pcmData: pcmData))
    }
    return .failure(HelperError(code: "unsupported_audio_format", message: "Unsupported WAV format=\(audioFormat) bits=\(bitsPerSample)"))
  }

  if raw.count < 2 {
    return .failure(HelperError(code: "empty_audio", message: "Decoded audio contains zero PCM frames"))
  }

  return .success(
    ParsedAudio(
      sampleRate: fallbackSampleRate,
      channels: 1,
      bitsPerSample: 16,
      isFloat: false,
      pcmData: raw
    )
  )
}

private func appendParsedAudioInMemory(
  _ audio: ParsedAudio,
  to request: SFSpeechAudioBufferRecognitionRequest
) -> Result<Int, HelperError> {
  let bytesPerSample = audio.bitsPerSample / 8
  let bytesPerFrame = bytesPerSample * audio.channels
  let totalFrames = audio.pcmData.count / max(1, bytesPerFrame)
  if totalFrames <= 0 {
    return .failure(HelperError(code: "empty_audio", message: "Decoded audio contains zero PCM frames"))
  }

  guard let format = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: Double(audio.sampleRate),
    channels: AVAudioChannelCount(audio.channels),
    interleaved: false
  ) else {
    return .failure(HelperError(code: "audio_format_error", message: "Could not initialize AVAudioFormat"))
  }

  let chunkCapacity = 16_000
  var frameCursor = 0

  while frameCursor < totalFrames {
    let framesThisChunk = min(chunkCapacity, totalFrames - frameCursor)
    guard let pcmBuffer = AVAudioPCMBuffer(
      pcmFormat: format,
      frameCapacity: AVAudioFrameCount(framesThisChunk)
    ), let channelData = pcmBuffer.floatChannelData else {
      return .failure(HelperError(code: "buffer_alloc_failed", message: "Could not allocate AVAudioPCMBuffer"))
    }

    pcmBuffer.frameLength = AVAudioFrameCount(framesThisChunk)

    for f in 0..<framesThisChunk {
      let frameByteOffset = (frameCursor + f) * bytesPerFrame
      for ch in 0..<audio.channels {
        let sampleOffset = frameByteOffset + ch * bytesPerSample
        let sampleValue: Float
        if audio.isFloat {
          let rawFloat = Float(bitPattern: readUInt32LE(audio.pcmData, at: sampleOffset))
          sampleValue = rawFloat.isFinite ? rawFloat : 0.0
        } else {
          let signed = Int16(bitPattern: readUInt16LE(audio.pcmData, at: sampleOffset))
          sampleValue = Float(signed) / 32_768.0
        }
        channelData[ch][f] = max(-1.0, min(1.0, sampleValue))
      }
    }

    request.append(pcmBuffer)
    frameCursor += framesThisChunk
  }

  request.endAudio()
  return .success(totalFrames)
}

private func resolveAuthorizationStatus(allowPrompt: Bool) -> SFSpeechRecognizerAuthorizationStatus {
  let current = SFSpeechRecognizer.authorizationStatus()
  if current != .notDetermined || !allowPrompt {
    return current
  }

  let authState = LockedAuthState()
  SFSpeechRecognizer.requestAuthorization { nextStatus in
    authState.set(nextStatus)
  }

  let deadline = Date().addingTimeInterval(authPromptTimeoutSec)
  while authState.get() == nil && Date() < deadline {
    let sliceLimit = min(deadline, Date(timeIntervalSinceNow: 0.05))
    if !RunLoop.main.run(mode: .default, before: sliceLimit) {
      let remaining = deadline.timeIntervalSinceNow
      if remaining > 0 {
        Thread.sleep(forTimeInterval: min(0.05, remaining))
      }
    }
  }
  return authState.get() ?? SFSpeechRecognizer.authorizationStatus()
}

// MARK: - Entry Point

private func runMain() -> Never {
  // Prevent broken stdout pipes from terminating the helper abruptly with SIGPIPE.
  _ = signal(SIGPIPE, SIG_IGN)

  let options = parseCliOptions(CommandLine.arguments)
  let initialStatus = SFSpeechRecognizer.authorizationStatus()

  if options.checkOnly {
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: options.locale))
    let available = recognizer?.isAvailable ?? false
    let supportsOnDevice = recognizer?.supportsOnDeviceRecognition ?? false
    let onDeviceOk = !options.requireOnDevice || supportsOnDevice
    let ok = initialStatus == .authorized && available && onDeviceOk
    let checkCode: String?
    if ok {
      checkCode = nil
    } else if initialStatus != .authorized {
      checkCode = "permission_\(authStatusString(initialStatus))"
    } else if !available {
      checkCode = "recognizer_unavailable"
    } else {
      checkCode = "on_device_unavailable"
    }
    emitAndExit(
      HelperOutput(
        ok: ok,
        text: "",
        locale: options.locale,
        onDevice: supportsOnDevice,
        authStatus: authStatusString(initialStatus),
        code: checkCode,
        error: ok ? nil : "Speech recognizer check: status=\(authStatusString(initialStatus)), available=\(available), onDevice=\(supportsOnDevice)"
      ),
      exitCode: ok ? 0 : 2
    )
  }

  // Never spam dialogs if permission was already denied or restricted.
  let authStatus = resolveAuthorizationStatus(allowPrompt: options.requestAuth)
  if authStatus != .authorized {
    let code: String
    let message: String
    switch authStatus {
    case .denied:
      code = "permission_denied"
      message = "macOS 语音识别权限已被拒绝，请在「系统设置 → 隐私与安全性 → 语音识别」中启用权限。"
    case .restricted:
      code = "permission_restricted"
      message = "当前 macOS 设备限制了语音识别权限。"
    case .notDetermined:
      code = "permission_not_determined"
      message = "尚未授予 macOS 语音识别权限，请在「系统设置 → 隐私与安全性 → 语音识别」中允许访问。"
    case .authorized:
      code = "permission_unavailable"
      message = "无法确认 macOS 语音识别权限状态。"
    @unknown default:
      code = "permission_unavailable"
      message = "无法确认 macOS 语音识别权限状态。"
    }
    emitAndExit(
      HelperOutput(
        ok: false,
        text: "",
        locale: options.locale,
        onDevice: false,
        authStatus: authStatusString(authStatus),
        code: code,
        error: message
      ),
      exitCode: 2
    )
  }

  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: options.locale)) else {
    emitAndExit(
      HelperOutput(
        ok: false,
        text: "",
        locale: options.locale,
        onDevice: false,
        authStatus: authStatusString(authStatus),
        code: "unsupported_locale",
        error: "macOS Speech recognizer does not support locale \(options.locale)"
      ),
      exitCode: 3
    )
  }

  guard recognizer.isAvailable else {
    emitAndExit(
      HelperOutput(
        ok: false,
        text: "",
        locale: options.locale,
        onDevice: recognizer.supportsOnDeviceRecognition,
        authStatus: authStatusString(authStatus),
        code: "recognizer_unavailable",
        error: "macOS Speech recognizer is currently unavailable for locale \(options.locale)"
      ),
      exitCode: 3
    )
  }

  let rawAudio: Data
  switch readStdinAudioInMemory(maxBytes: maxStdinAudioBytes) {
  case .success(let data):
    rawAudio = data
  case .failure(let err):
    emitAndExit(
      HelperOutput(
        ok: false,
        text: "",
        locale: options.locale,
        onDevice: false,
        authStatus: authStatusString(authStatus),
        code: err.code,
        error: err.message
      ),
      exitCode: 4
    )
  }

  let parsedAudio: ParsedAudio
  switch parseAudioBytes(rawAudio, fallbackSampleRate: options.sampleRate) {
  case .success(let audio):
    parsedAudio = audio
  case .failure(let err):
    emitAndExit(
      HelperOutput(
        ok: false,
        text: "",
        locale: options.locale,
        onDevice: false,
        authStatus: authStatusString(authStatus),
        code: err.code,
        error: err.message
      ),
      exitCode: 4
    )
  }

  let request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  request.taskHint = .dictation

  var useOnDevice = false
  if options.requireOnDevice {
    if recognizer.supportsOnDeviceRecognition {
      request.requiresOnDeviceRecognition = true
      useOnDevice = true
    } else {
      emitAndExit(
        HelperOutput(
          ok: false,
          text: "",
          locale: options.locale,
          onDevice: false,
          authStatus: authStatusString(authStatus),
          code: "on_device_unavailable",
          error: "On-device macOS Speech model is not installed for locale \(options.locale)"
        ),
        exitCode: 3
      )
    }
  }

  // Deliver callbacks on a dedicated background OperationQueue to avoid main-thread deadlocks.
  let callbackQueue = OperationQueue()
  callbackQueue.name = "ai.asi.speech-helper.callbacks"
  callbackQueue.maxConcurrentOperationCount = 1
  recognizer.queue = callbackQueue

  let state = LockedRecognitionState()
  let task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
      let text = result.bestTranscription.formattedString
      state.recordPartial(text)
      if result.isFinal {
        state.completeSuccess(text)
        return
      }
    }
    if let error = error {
      let nsErr = error as NSError
      let snap = state.snapshot()
      if !snap.latestText.isEmpty {
        state.completeSuccess(snap.latestText)
        return
      }
      // Apple kAFAssistantErrorDomain code 1110 / 203 indicate silence / no recognizable speech.
      let lowerDesc = nsErr.localizedDescription.lowercased()
      if nsErr.code == 1110
        || nsErr.code == 203
        || lowerDesc.contains("no speech detected")
        || nsErr.localizedDescription.contains("未检测到语音")
      {
        state.completeError(code: "no_speech", message: "No speech detected")
        return
      }
      state.completeError(code: "recognition_failed", message: nsErr.localizedDescription)
    }
  }

  if case .failure(let err) = appendParsedAudioInMemory(parsedAudio, to: request) {
    task.cancel()
    emitAndExit(
      HelperOutput(
        ok: false,
        text: "",
        locale: options.locale,
        onDevice: useOnDevice,
        authStatus: authStatusString(authStatus),
        code: err.code,
        error: err.message
      ),
      exitCode: 4
    )
  }

  let deadline = Date().addingTimeInterval(TimeInterval(options.timeoutMs) / 1000.0)
  while !state.isFinished() && Date() < deadline {
    let sliceLimit = min(deadline, Date(timeIntervalSinceNow: 0.03))
    if !RunLoop.main.run(mode: .default, before: sliceLimit) {
      let remaining = deadline.timeIntervalSinceNow
      if remaining > 0 {
        Thread.sleep(forTimeInterval: min(0.03, remaining))
      }
    }
  }

  let finalSnap = state.snapshot()
  if !finalSnap.finished {
    task.cancel()
    if !finalSnap.latestText.isEmpty {
      emitAndExit(
        HelperOutput(
          ok: true,
          text: finalSnap.latestText,
          locale: options.locale,
          onDevice: useOnDevice,
          authStatus: authStatusString(authStatus),
          code: nil,
          error: nil
        ),
        exitCode: 0
      )
    }
    emitAndExit(
      HelperOutput(
        ok: false,
        text: "",
        locale: options.locale,
        onDevice: useOnDevice,
        authStatus: authStatusString(authStatus),
        code: "timeout",
        error: "macOS Speech recognition timed out after \(options.timeoutMs)ms"
      ),
      exitCode: 5
    )
  }

  if task.state == .starting || task.state == .running {
    task.finish()
  }

  if let text = finalSnap.finalText {
    emitAndExit(
      HelperOutput(
        ok: true,
        text: text,
        locale: options.locale,
        onDevice: useOnDevice,
        authStatus: authStatusString(authStatus),
        code: nil,
        error: nil
      ),
      exitCode: 0
    )
  }

  if finalSnap.errorCode == "no_speech" {
    emitAndExit(
      HelperOutput(
        ok: true,
        text: "",
        locale: options.locale,
        onDevice: useOnDevice,
        authStatus: authStatusString(authStatus),
        code: "no_speech",
        error: nil
      ),
      exitCode: 0
    )
  }

  emitAndExit(
    HelperOutput(
      ok: false,
      text: "",
      locale: options.locale,
      onDevice: useOnDevice,
      authStatus: authStatusString(authStatus),
      code: finalSnap.errorCode ?? "recognition_failed",
      error: finalSnap.errorMessage ?? "macOS Speech recognition failed"
    ),
    exitCode: 1
  )
}

runMain()
