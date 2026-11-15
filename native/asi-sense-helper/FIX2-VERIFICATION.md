# Privacy Barrier Fix 2
Baseline: d2a7d20; changes stay within native/asi-sense-helper.
Verification: swift build -c release exits 0; scripts/smoke.sh PASS with existing Accessibility grant.
Tests: swift test --filter "AXSessionTests|ProcessTests|CommandChannelTests|OutputWriterTests|InputReaderTests|CommandTests|ProtocolTests|TitleDebouncerTests" selects all 8 suites: 82 tests, 0 failures.
1. Reliable controls and typed input drops -> testFixtureAControlBypassesBlockedSnapshotAndOverflow.
2. Acknowledged privacy barrier during blocked AX -> testFixtureBAckPrecedesGateReleaseSnapshotHasNoTitle; testTitlesAckRoundTripsIds.
3. Atomic title output under backpressure -> testFixtureC1FullPipeQueuedTitleNeverWrittenAfterToggle; testFixtureC2PartialFreeSpaceTitleNeverWritten; testTitleLineAtomicAndPurgeKeepsValidJSON.
4. Critical event reliability and typed immediate output overflow -> testChannelCriticalKindsSurviveEviction; testEvictionReportsOverflowImmediatelyWithTypes; testOverflowReportPartialWriteKeepsAccurateCounts.
5. Bounded, generation-stamped privacy work -> testPrivacyToggleStormCoalesces; testStaleRefreshNeverReadsTitleAfterPrivacyFlip.
6. Initial windowless focus -> testWindowlessInitialAttachEmitsWindowNullOnce; testWindowlessAfterAppSwitchEmitsAgain.
7. Optional AXTitle failures preserve focus -> testPermanentTitleFailureStillEmitsFocused; testPermanentTitleFailureOnSnapshotAndNotifyKeepsAttach.
8. Scoped AX error identity and stale delivery rejection -> testStaleAxErrorsDropAfterAppSwitch; testStaleRetryableErrorDropsAfterAppSwitch; testBlockedErrorKeepsProducingStampNotCurrent; testAxErrorIdentityCarriesPidAndBundle.
Platform adjustment: Darwin PIPE_BUF is 512, so title lines use min(4096, PIPE_BUF), including LF, rather than incorrectly assuming 4096-byte atomicity.
Size deviation: approximately 2,100 added/deleted lines including process-fixture and regression coverage, exceeding the <=1,000-line target.
Evidence: /tmp/macos-helper-fix2-release.log; /tmp/macos-helper-fix2-rework-tests.log; /tmp/macos-helper-fix2-smoke.log.
No TCC changes, permission prompts, secrets access, production connections, model requests, or remaining self-started helpers; pnpm check unavailable because this baseline has no package.json.
