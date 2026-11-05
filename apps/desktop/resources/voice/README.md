# Bundled voice engine

`pnpm bundle:whisper` generates `mac-arm64/` from Homebrew `whisper.cpp`.
The generated binaries and dylibs are intentionally excluded from git and are
copied into the packaged app as `Resources/voice/`.

The local transcription model is downloaded once to the app userData
directory and verified by SHA-256 before use.
