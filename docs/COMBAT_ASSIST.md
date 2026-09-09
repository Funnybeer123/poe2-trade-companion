# Flasks and Unleash

Open **Tools & QA → Flasks & Unleash** in the Windows app.

The health and mana modules press their configured flask keys when the visible
globe falls **below 25%** (25% exactly does not trigger). Defaults are health **1**,
mana **Mouse Button 5**, and Unleash **R**. Each feature has its own toggle. Thresholds and bindings
are editable. The flask retry interval defaults to 1500 ms to allow recovery
without draining charges on every captured frame; adjust it to your flasks.

Choose **Mouse Button 5** in the mana **Key / button** dropdown. It sends the
second Windows side-button (XBUTTON2) down/up without moving the cursor. Existing
saved bindings are preserved; change a previously saved mana binding of 2 to
Mouse Button 5 and click Save settings.
Mouse input also requires the pointer to be over the unobstructed game client;
it is blocked if the cursor is over another window.

Unleash casts once when the calibrated skill-bar icon looks ready, then waits
until it has seen the calibrated cooldown appearance in two consecutive frames
before allowing another cast. It does not infer a fixed cooldown duration.
If the game rejects a cast and never enters cooldown, pause/resume to retry.

## First-time calibration

1. Use windowed or borderless mode. Fill both globes and close game panels.
2. Click **Capture game in 3 seconds**, switch to the game during the countdown,
   then return to the companion once it has captured. If switching takes longer,
   capture waits up to 15 seconds for game focus; Stop cancels that wait.
3. Select **Health**. Click two opposite corners of a narrow vertical strip
   inside the red globe, spanning the liquid's full height. Exclude its frame,
   labels and white reflections. Repeat with **Mana** inside the blue globe.
4. Select **Unleash ready** and select the purple **R skill-bar icon** while
   available. Use the inside of the icon, excluding its border and key label.
   The skill-book entry is not the cooldown indicator.
5. Select **Fixed HUD ornament** and select a distinctive, static part of the
   globe's surrounding frame. Keep it close to the bottom HUD. Do not select
   empty space, numbers or animated art. This helps reject hidden/covered HUDs.
6. Select **Unleash on cooldown**, capture again, and cast R yourself before the
   countdown expires. Click **Record cooldown from screenshot**. The previously
   selected skill region is reused. Very similar ready/cooldown samples are
   rejected; capture early in the cooldown.
7. Enable the desired toggles and **Preview only**, then **Save & start**.
   Compare the displayed health/mana estimates with the game. Preview traces
   show intended actions without emitting keys.
8. When calibration is correct, turn off Preview only and the app's global
   Dry-run switch. Click **Save & start**, then return to the game.

Changing window resolution, HUD scaling, colour settings or the bound skill
requires recalibration. Moving the window keeps client-relative regions valid;
an in-flight action is rejected if the window moves after its capture.

## Controls and behavior

- **F8:** pause/resume the saved configuration from anywhere.
- **Ctrl+Shift+Esc:** stop and latch all app input. Windows may also open Task
  Manager. An independent 8 ms native key observer handles this combination
  when Windows refuses to register it as an application shortcut.
- **Ctrl+Shift+F12:** backup emergency stop.
- **Stop:** terminate the combat worker immediately.
- **Rearm:** clear the emergency latch; automation still needs an explicit start.
- **Save settings:** persist changes and stop the loop. Saving does not emit keys.
- Restarting the app retains configuration but always starts combat stopped.
- Pause with F8 before opening chat or menus. The feature recognizes calibrated
  HUD pixels; it does not fully understand every game panel or text-input state.

The companion only sends input to an exact allowlisted PoE executable in the
foreground. It rechecks window identity, client bounds, modifiers, action-key
state and capture age immediately before each keypress. It never brings the game
to the foreground. Other in-app transfer/sort/scan operations stop combat; resume
explicitly afterward. A global Dry-run change stops live combat.

## Speed and limits

The requested polling interval defaults to **16 ms**. This is a scheduling target,
not a guarantee of 16 ms detection-to-cast latency. Capture, Windows scheduling,
the game's frame rate, and input acceptance affect real response time. The panel
shows the last completed capture/decision/input cycle in milliseconds.

The persistent Windows worker takes one capture of the band containing the HUD
regions, reuses its bitmap, and sends compact RGB samples over a persistent pipe.
There is no per-frame process startup, OCR, PNG encoding, filesystem screenshot,
network access or renderer dependency. Health is processed before mana and R.
Captures never overlap or build up a backlog. Frames older than 120 ms are
rejected, and there is a combined limit of 240 actions per minute.

Screen-derived globe percentages are estimates. Covered or unexpected-colour
regions can be rejected, and the skill must match its learned ready appearance.
Flask charges, actual healing and server-side cast acceptance are not directly
observable through this feature. Live gameplay accuracy and end-to-end latency
must be checked with the user's own calibrated HUD.

Settings are saved under the Electron user-data directory at
`combat/combat-assist.json`. Action traces are appended to daily
`combat/combat-actions-YYYY-MM-DD.jsonl` files. Each includes the observed values,
decision reason, key and controller result. Trace files are local and can be
removed when no longer needed.

## Developer verification

- `npm run typecheck` and `npm run lint`
- `npx vitest run tests/combat-assist.test.ts tests/combat-assist-service.test.ts tests/component/combat-assist-tool.test.ts tests/integration/preload-contract.test.ts tests/windows-emergency-stop.test.ts`
- `powershell.exe -NoProfile -File scripts/test-combat-host.ps1`
- `npm run pack:smoke`
- `npm run test:e2e -- --grep "combat controls"`

Replay and native synthetic tests emit no game input. The synthetic native RGB
test measures extraction from an in-memory bitmap, excluding screen capture and
input; it must not be reported as end-to-end gameplay latency.

Windows key emission uses one down/up batch through
[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
behind `GameInputController` and `CombatInputSink`.
