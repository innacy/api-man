build:
	go build -o apiperf .

# Native desktop app → build/bin/apiperf (Linux needs libgtk-3-dev libwebkit2gtk-4.1-dev).
# Nearest git tag (v0.2.2 → 0.2.2) so local installs get the update check too.
VERSION := $(shell git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')
VERSION := $(or $(VERSION),dev)

app:
	wails build -s -skipbindings -clean -tags webkit2_41 -ldflags "-X main.version=$(VERSION)"

# Install "API-Man" into the app menu for the current user.
install-desktop: app
	install -Dm755 build/bin/apiperf ~/.local/bin/apiperf
	install -Dm644 build/appicon.svg ~/.local/share/icons/hicolor/scalable/apps/apiperf.svg
	mkdir -p ~/.local/share/applications
	sed "s|@BIN@|$(HOME)/.local/bin/apiperf|" deploy/apiperf.desktop > ~/.local/share/applications/apiperf.desktop

uninstall-desktop:
	rm -f ~/.local/bin/apiperf ~/.local/share/icons/hicolor/scalable/apps/apiperf.svg ~/.local/share/applications/apiperf.desktop
