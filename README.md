<p align="center">
  <img src="build/appicon.svg" width="96" alt="API-Man icon">
</p>

<h1 align="center">API-Man</h1>

<p align="center">
  A local API client and load tester in one desktop app.<br>
  Send requests, organize them in collections, then load-test any request and get exact latency percentiles.
</p>

<p align="center">
  <a href="https://github.com/innacy/api-man/releases/latest">Download</a> ·
  <a href="#features">Features</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#building-from-source">Build</a> ·
  <a href="LICENSE">MIT License</a>
</p>

---

## Features

### API client
- **Requests**: any HTTP method, query params, headers, body, with a per-request timeout, redirect and TLS-verification setting.
- **Auth**: Bearer token, Basic auth and API key.
- **Collections**: group saved requests into collections and folders, and search everything with <kbd>Ctrl</kbd>+<kbd>K</kbd>.
- **Variables**: use `{{name}}` anywhere. Define them per environment, per collection (collection ⋯ → Variables) or globally (Environments → Globals); environment beats collection beats global, as in Postman. Hover a variable in the URL bar to see its value and where it comes from.
- **Scripts**: Postman-compatible pre-request and post-response scripts (`pm.*`) on requests, folders and collections, with `pm.test` results in a Tests tab. Scripts run in a sandbox with no network access; `pm.sendRequest` and `require` aren't supported.
- **Cookies**: cookies set by responses are saved per site and sent back automatically, like a browser. Manage them under **Cookies** in the bottom bar, or turn them off per request in Settings.
- **History**: every request you send is recorded and can be reopened.
- **Paste a curl**: paste a curl command into the URL bar and it becomes a request.
- **Code generation**: export any request as cURL, JavaScript (fetch), Python (requests), Go (net/http), HTTPie or PowerShell.
- **Postman import**: import Postman collections (v2.0/v2.1, including variables and scripts), environments and globals.

### Load testing
- **Staged ramp**: from 100 to 1M requests at rising concurrency, with an editable stage plan.
- **Exact percentiles**: p50, p90, p95 and p99 per stage, computed from every recorded response time rather than estimated.
- **Live dashboard**: charts and stage results update as the run happens, with a kill switch to stop it.
- **Verdict**: saturation-point detection and an error breakdown. It also flags when the load generator, not your API, is the bottleneck.
- **Auto-abort**: a run stops early when a stage exceeds the error-rate or p99 thresholds you set.
- **Run history**: every run is stored and can be reopened later.

### App
- **Native desktop app** for Windows, macOS and Linux, with no browser required. It opens on a Home page with quick actions and recent work.
- **Local only**: requests, history and environments stay in a local database on your machine. Nothing is synced or sent anywhere. The only outbound call is a check for new versions.
- **Update notice**: an "Update available" button appears in the title bar when a new release is out.
- **Themes**: light and dark modes plus several accent colors.

## Installation

Download the file for your OS from the [latest release](https://github.com/innacy/api-man/releases/latest).

| OS | File | Install |
|---|---|---|
| **Windows** 10/11 | `API-Man-amd64-installer.exe` | Run the installer. SmartScreen may say "unknown publisher": choose **More info → Run anyway**. |
| **macOS** 11+ (Intel and Apple Silicon) | `API-Man-macos-universal.zip` | Unzip and drag **API-Man** into Applications. The first time, **right-click → Open**, since the app is not notarized. Alternatively run `xattr -cr /Applications/API-Man.app`. |
| **Linux** (Debian/Ubuntu) | `apiperf_<version>_amd64.deb` | `sudo apt install ./apiperf_<version>_amd64.deb` |
| **Linux** (other) | `apiperf-linux-amd64` | `chmod +x apiperf-linux-amd64 && ./apiperf-linux-amd64`. Requires GTK 3 and WebKitGTK 4.1. |

### Updating
When a new version is out, an **Update available** button appears in the title bar, and clicking it opens the release page. Close API-Man, then install the new version over the old one exactly as above. Your requests, history and run results are kept.

### Uninstalling
- **Windows**: Settings → Apps → API-Man → Uninstall.
- **macOS**: delete `API-Man.app` from Applications.
- **Linux**: `sudo apt remove apiperf`.

Your data is not removed by uninstalling. Delete the data folder (see [Data](#data)) as well if you want a clean slate.

## Usage

### Send a request
1. Type a URL, or paste a full curl command, into the URL bar.
2. Set params, auth, headers and body in the tabs below it.
3. Press **Send** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>). The response, its headers and a timing breakdown appear on the right.
4. Press <kbd>Ctrl</kbd>+<kbd>S</kbd> to save the request into a collection.

### Load-test a request
1. Open a request and click **Load test**, or choose **New load test** in the sidebar and paste a curl command.
2. Click **Verify**. API-Man sends one probe request so you can confirm the target responds as expected.
3. Adjust the stage plan and the auto-abort thresholds if you like, then click **Start**.
4. Watch results live. When the run finishes, the report shows charts, per-stage percentiles and a verdict.
5. Past runs are under **Past load tests**.

> **Only load-test APIs you own or have permission to test.** Targets outside your private network require an explicit confirmation before a run starts.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Send request |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Save / save as new |
| <kbd>Ctrl</kbd>+<kbd>N</kbd> or <kbd>Ctrl</kbd>+<kbd>T</kbd> | New request tab |
| <kbd>Ctrl</kbd>+<kbd>W</kbd> | Close tab |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> | Reopen closed tab |
| <kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> | Next / previous tab |
| <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>8</kbd>, <kbd>Ctrl</kbd>+<kbd>9</kbd> | Go to tab N, last tab |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> or <kbd>Ctrl</kbd>+<kbd>P</kbd> | Search everything |
| <kbd>Ctrl</kbd>+<kbd>L</kbd> | Focus the URL bar |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | Find in the response |
| <kbd>Delete</kbd> / <kbd>Shift</kbd>+<kbd>Delete</kbd> | Delete the selected sidebar item (Shift skips the question) |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> | Show / hide the sidebar |
| <kbd>Ctrl</kbd>+<kbd>J</kbd> | Show / hide the response |
| <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> | Format the JSON body |
| <kbd>F1</kbd> | Show all shortcuts |

On macOS use <kbd>Cmd</kbd> in place of <kbd>Ctrl</kbd>. In browser mode, Chrome keeps <kbd>Ctrl</kbd>+<kbd>N</kbd>/<kbd>T</kbd>/<kbd>W</kbd> for itself, so use <kbd>Alt</kbd>+<kbd>N</kbd>/<kbd>W</kbd>/<kbd>Shift</kbd>+<kbd>T</kbd> there instead.

### Browser mode
To run API-Man without a window, for example on a server, start it with `apiperf -headless` and open <http://localhost:7071>. It only accepts connections from the local machine.

## Data

Everything is stored in SQLite databases in your per-user data folder:

| OS | Folder |
|---|---|
| Linux | `~/.local/share/apiperf` (or `$XDG_DATA_HOME/apiperf`) |
| Windows | `%AppData%\apiperf` |
| macOS | `~/Library/Application Support/apiperf` |

- `requests.db` holds collections, environments and request history.
- `apiperf.db` holds load-test runs. A full 1M-request run stores about 1.1M rows (roughly 40 MB).

## Building from source

Requirements:
- Go 1.25+
- [Wails CLI](https://wails.io) v2: `go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.2`
- On Linux: `sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev`

```sh
git clone https://github.com/innacy/api-man.git
cd api-man

make app                # desktop app → build/bin/apiperf
make install-desktop    # Linux: install it into your app menu (make uninstall-desktop removes it)

go build -o apiperf . && ./apiperf -headless   # browser mode, no Wails needed
```

### Tests

```sh
go test ./...                   # unit, integration and e2e tests
node --test server/*.test.js    # UI logic: code generation, Postman import, scripts
```

The e2e suite in `e2e/` builds the real binary and drives it over HTTP. It needs port 7071 free, so close the app first.

### Releasing
1. Update `productVersion` in `wails.json` and commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.

GitHub Actions runs the full test suite on Linux, macOS and Windows. Only if that passes does it build the installers and publish them to a GitHub Release.

## Troubleshooting

- **"cannot bind localhost:7071 (already running?)"**: API-Man is already open. Only one copy can run at a time.
- **File-descriptor errors at high concurrency**: raise `ulimit -n`. API-Man raises its own soft limit at startup, but the hard limit caps it.
- **Throughput plateaus while the API looks healthy**: the machine generating the load is probably the bottleneck. The verdict will say so.

## License

[MIT](LICENSE) © 2026 innacy
