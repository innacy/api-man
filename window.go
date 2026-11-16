package main

import (
	_ "embed"
	"net/http"
	"runtime"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
)

//go:embed build/appicon.png
var appIcon []byte

// runWindow opens a native OS webview window and blocks until it closes.
// The window just navigates to the real localhost server: Wails' in-process
// asset handler doesn't stream reliably, and the UI depends on SSE
// (/api/events). The server code stays identical to -headless mode.
func runWindow() error {
	// macOS routes Cmd+C/V/X/A/Z and Cmd+Q through the app menu; without one
	// they do nothing in the webview. Other OSes handle them natively and
	// would show this as a menu bar, so it's macOS-only.
	var appMenu *menu.Menu
	if runtime.GOOS == "darwin" {
		appMenu = menu.NewMenu()
		appMenu.Append(menu.AppMenu())
		appMenu.Append(menu.EditMenu())
	}
	return wails.Run(&options.App{
		Menu:      appMenu,
		Title:     "API-Man",
		Width:     1400,
		Height:    900,
		MinWidth:  900,
		MinHeight: 600,
		// ProgramName = the .desktop basename, so GNOME ties the window to its menu icon.
		Linux: &linux.Options{Icon: appIcon, ProgramName: "apiperf"},
		AssetServer: &assetserver.Options{
			Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				w.Write([]byte(`<script>location.replace("http://localhost:7071/#home")</script>`))
			}),
		},
	})
}
