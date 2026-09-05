# Local injection and debugging

Use this when testing LawyerCord code in the installed Discord client without making a release.

## First install

Run PowerShell from the LawyerCord checkout:

```powershell
pnpm install --frozen-lockfile
pnpm buildStandalone
$env:LAWYERCORD_INSTALLER_PATH = "C:\path\to\verified\EquilotlCli.exe"
pnpm inject
```

Fully close Discord, including its tray process, then reopen it.

The injected `app.asar` is a small loader that points at this checkout's `dist\desktop` folder. It does not copy the current bundle into Discord.

## Normal update loop

For later source changes:

```powershell
pnpm testTsc
pnpm buildStandalone
```

Restart or reload Discord after the build. Do not run `pnpm inject` again unless Discord replaced the loader or the checkout moved.

Use `pnpm dev` to rebuild the desktop bundle after every saved change. Wait for the build to finish before reloading Discord.

## Open Discord for local debugging

Close every Discord process first. Then start the newest installed client with its loopback debugging endpoint:

```powershell
Get-Process Discord -ErrorAction SilentlyContinue | Stop-Process
$discordExe = Get-ChildItem "$env:LOCALAPPDATA\Discord\app-*\Discord.exe" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (!$discordExe) { throw "Discord.exe was not found." }
Start-Process -FilePath $discordExe.FullName -ArgumentList "--remote-debugging-port=9222"
```

Check that another local process can attach:

```powershell
Invoke-RestMethod "http://127.0.0.1:9222/json/version" |
    Select-Object Browser, webSocketDebuggerUrl
```

Repo scripts use `DISCORD_DEBUG_URL` and default to `http://127.0.0.1:9222`:

```powershell
$env:DISCORD_DEBUG_URL = "http://127.0.0.1:9222"
```

The debugging endpoint gives local programs control of the Discord page. Enable it only while debugging. Live scripts have separate confirmation flags and target ID checks. Do not bypass them.

## DevTools

Enable the `Experiments` plugin, then press `Ctrl+Alt+O` to open Discord DevTools. Use the Console for runtime errors and the Network panel for failed requests.

LawyerCord Settings also has an `Enable React Developer Tools` option. It requires a restart and is useful when a React component renders with the wrong props or state.

## Logs

Discord writes renderer output here on the normal Windows channel:

```powershell
$rendererLog = "$env:APPDATA\discord\logs\renderer_js.log"
Get-Content -LiteralPath $rendererLog -Tail 200 -Wait
```

Filter the latest output when the full log is noisy:

```powershell
Get-Content -LiteralPath $rendererLog -Tail 1000 |
    Select-String -Pattern "LawyerCord|Automations|OpenRouter|error|failed"
```

List every current Discord log if the problem happened before the renderer loaded:

```powershell
Get-ChildItem "$env:APPDATA\discord\logs" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object LastWriteTime, Length, Name
```

PTB and Canary use different folders under `$env:APPDATA`. Check timestamps so old startup errors are not mistaken for errors from the current build.

## Local tests

Run the smallest relevant check while editing:

```powershell
pnpm testTsc
pnpm eslint src\path\to\changed-file.tsx
pnpm stylelint src\path\to\changed-file.css
git diff --check
```

Run the feature test when one exists. Automations use:

```powershell
pnpm testAutomations
```

Before handing off a desktop build:

```powershell
pnpm buildStandalone
```

Then open the changed screen in Discord, perform one safe test, and watch both DevTools and `renderer_js.log`. A successful build does not prove the injected UI loaded.

## Repair or remove

Keep `LAWYERCORD_INSTALLER_PATH` set for these commands:

```powershell
pnpm repair
pnpm uninject
```

Run `pnpm inject` again after a Discord update replaces `app.asar`, after moving the checkout, or when repair cannot restore the loader.

Do not inject an unreviewed branch into an account you care about. Do not put tokens, API keys, message contents, or private IDs in logs or test fixtures.
