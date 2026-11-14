# API Benchmark

Paste a curl command, get the full performance story of your API: a staged
load ramp (100 → 1M requests, rising concurrency), exact p50/p90/p95/p99 per
stage, error breakdown, throughput, saturation-point detection, live
dashboard, kill switch, and run history — from one Go binary.

## Run

    go build -o apiperf . && ./apiperf -headless
    # open http://localhost:7071

## Desktop app

Download from GitHub Releases (push a `v*` tag to build them):

- **Windows**: `API-Man-amd64-installer.exe`. SmartScreen will say "unknown publisher" → More info → Run anyway.
- **macOS**: unzip `API-Man-macos-universal.zip` into Applications. It isn't notarized, so the first time
  right-click → Open (or run `xattr -cr /Applications/API-Man.app`).
- **Linux**: `sudo apt install ./apiperf_*.deb`

Build locally: `go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.2`, then
`make app` (Linux needs `libgtk-3-dev libwebkit2gtk-4.1-dev`), or `make install-desktop`
to add it to your app menu. The window is a native webview over the same localhost:7071
server; closing it stops apiperf.

Data lives in the per-user folder: `~/.local/share/apiperf` (Linux),
`%AppData%\apiperf` (Windows), `~/Library/Application Support/apiperf` (macOS).

Paste your curl (supported flags: -X, -H, -d/--data*, -u, -k, -L, --url), hit Verify,
tune the stage plan if you like, Start. Results stream live; the final
report includes charts and a verdict. Every response time is stored in
`apiperf.db` (SQLite, in the data folder above); the History tab reopens any past run.

## Notes

- Auto-abort: a run stops early when a stage exceeds the error-rate or p99
  thresholds (editable in the UI).
- Only load-test APIs you own or have permission to test. Non-private hosts
  require an explicit confirmation.
- At high concurrency the generator machine can be the bottleneck; the
  verdict flags this when throughput plateaus while the API stays healthy.
  Raise `ulimit -n` if you see file-descriptor errors (the binary attempts
  to raise its own soft limit at startup).
- A full 1M-request ramp stores ~1.1M rows (~40 MB) per run.
