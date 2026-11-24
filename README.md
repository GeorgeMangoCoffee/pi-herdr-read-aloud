# pi + Herdr read-aloud

Pi reads its replies aloud. Herdr gets a status-bar control.

![Read aloud: Off F8 · Play last F9 · Stop F10](screenshot.png)

Windows only. Uses Microsoft neural voices via `edge-tts`. Needs internet.

## Parts

| Path | What it does |
|---|---|
| `pi-extension/read-aloud.ts` | Pi extension. Saves each reply as speakable text. Speaks it when on. |
| `bin/read-aloud.ps1` | Speech engine. Queues, chunks, plays, stops. |
| `herdr-mod/read-aloud/` | Herdr mod. The status-bar buttons. |
| `herdr-config/keys.snippet.json` | F8, F9, F10 bindings. |
| `herdr-config/layout.snippet.json` | Example layout row for the bar. |

## Install

1. Install Python. Then run `pip install edge-tts`.
2. Check `edge-tts --help` works in PowerShell.
3. Copy `bin/read-aloud.ps1` to `%USERPROFILE%\bin\read-aloud.ps1`.
4. Copy `pi-extension/read-aloud.ts` to `%USERPROFILE%\.pi\agent\extensions\`.
5. Copy `herdr-mod/read-aloud` to `%USERPROFILE%\.config\herdr-app\mods\`.
6. Merge `keys.snippet.json` into `%USERPROFILE%\.config\herdr-app\keys.json`, under `global`.
7. Add the mod to a layout block. See `layout.snippet.json`. Place it in your bottom row.
8. Restart Herdr. Restart pi.

Those paths are fixed in the code. Change them in all three files if needed.

## Use

| Key | Pi command | Action |
|---|---|---|
| F8 | `/speak` | Toggle auto-read. Applies to all tabs. |
| F9 | `/speak-last` | Replay this tab's last reply. |
| F10 | `/speak-stop` | Stop and clear the queue. |
| Alt+S | `/speak-prompt` | Read your input box. |

Code blocks are skipped. Paths are shortened to file names. Links become "link to host".

## Change the voice

Edit `$Voice` at the top of `read-aloud.ps1`. List voices with `edge-tts --list-voices`.

## Troubleshooting

- Log: `%LOCALAPPDATA%\say\read-aloud.log`.
- Silent? Check the per-app volume for PowerShell.
- "Focus a pi tab first": click a pi pane, then press F9.
