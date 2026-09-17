# Flasks, Unleash and Powered by Verisium

Open **Tools & QA → Flasks & Unleash** in the Windows app.

The health and mana modules press their configured flask keys when the visible
globe falls **below 25%** (25% exactly does not trigger). Defaults are health **1**,
mana **Mouse Button 5**, Unleash **R** and Powered by Verisium **T**. Each feature has
its own toggle in Tools → Flasks & Unleash. Thresholds and bindings
are editable. The flask retry interval defaults to 1500 ms to allow recovery
without draining charges on every captured frame; adjust it to your flasks.

Choose **Mouse Button 5** in the mana **Key / button** dropdown. It sends the
second Windows side-button (XBUTTON2) down/up without moving the cursor. Existing
saved bindings are preserved; change a previously saved mana binding of 2 to
Mouse Button 5 and click Save settings.
Mouse input also requires the pointer to be over the unobstructed game client;
it is blocked if the cursor is over another window.

With **Manual Sigil macro** disabled, Unleash and Powered by Verisium each cast when their calibrated skill-bar icon
looks ready; the two skills are tracked independently, and in one frame Unleash
is pressed before Verisium. Two consecutive cooldown frames confirm a successful
cycle, and the next ready appearance allows another cast. If another action interrupts the cast, the app retries automatically
while the icon remains ready. It does not infer a fixed cooldown duration.
Retries require two consecutive valid ready frames and wait at least 750 ms
after the previous attempt, or the configured minimum gap if that is longer.
Unknown or covered icons do not trigger retries.

## First-time calibration

The manual Sigil macro does not require skill or HUD calibration. Follow these
steps only for enabled auto flasks or standalone automatic skill modules.

1. Use windowed or borderless mode. Fill both globes and close game panels.
2. On **HUD / ready**, click **Capture HUD / ready in 3 seconds**, switch to the game during the countdown,
   then return to the companion once it has captured. If switching takes longer,
   capture waits up to 15 seconds for game focus; Stop cancels that wait.
3. Select **Health**. Click two opposite corners of a narrow vertical strip
   inside the red globe, spanning the liquid's full height. Exclude its frame,
   labels and white reflections. Repeat with **Mana** inside the blue globe.
4. Select **Unleash ready** and select the purple **R skill-bar icon** while
   available. Use the inside of the icon, excluding its border and key label.
   The skill-book entry is not the cooldown indicator. Repeat with
   **Powered by Verisium ready** on the **T skill-bar icon** if you use that
   feature.
5. Select **Fixed HUD ornament** and select a distinctive, static part of the
   globe's surrounding frame. Keep it close to the bottom HUD. Do not select
   empty space, numbers or animated art. This helps reject hidden/covered HUDs.
6. Open the separate **Unleash cooldown** tab, click **Capture cooldown in 3 seconds**,
   and cast R yourself before the countdown expires. The **Powered by Verisium
   cooldown** tab works the same way (cast T during the countdown); each skill
   keeps its own cooldown screenshot. Check the capture time and
   icon crop, then click **Record cooldown from screenshot**. The saved skill
   region is sampled from this tab's screenshot; the HUD / ready screenshot is
   retained separately. Different-resolution cooldown captures cannot be recorded.
   Compare each skill's displayed **recorded ready reference** and **recorded
   cooldown reference** figures (one pair per skill): these show the exact
   16 × 16 RGB samples used by the detector, including previously saved
   references after restarting. Very similar samples are rejected; capture
   early in the cooldown.
7. Enable the desired toggles and **Preview only**, then **Save & start**.
   Compare the displayed health/mana estimates with the game. Preview traces
   show intended actions without emitting keys.
8. When calibration is correct, turn off Preview only and the app's global
   Dry-run switch. Click **Save & start**, then return to the game.

Changing window resolution, HUD scaling, colour settings or the bound skill
requires recalibration. Moving the window keeps client-relative regions valid;
an in-flight action is rejected if the window moves after its capture.

Unsaved settings, every tab's screenshot (HUD / ready and each skill's
cooldown), capture times and calibration selections survive navigation
between app sections for the current app session. Full
screenshots stay in memory only. Use **Save settings** to retain detector
references after restarting; screenshots must be captured again in a new session.

## Controls and behavior

- **F8:** pause/resume the saved configuration from anywhere. With Manual Sigil
  macro enabled, this arms it to wait for your next physical trigger press.
- **Ctrl+Shift+Esc:** stop and latch all app input. Windows may also open Task
  Manager. An independent 8 ms native key observer handles this combination
  when Windows refuses to register it as an application shortcut.
- **Ctrl+Shift+F12:** backup emergency stop.
- **Stop:** terminate the combat worker immediately.
- **Rearm:** clear the emergency latch; automation still needs an explicit start.
- **Save settings:** persist changes and stop the loop. Saving does not emit keys.
- Restarting the app retains configuration but always starts combat stopped.
- Pause with F8 before opening chat or menus. The manual macro does not inspect
  HUD pixels or identify text-input state; automatic modules use calibrated HUD pixels.

The companion only sends input to an exact allowlisted PoE executable in the
foreground. It rechecks window identity, client bounds, modifiers and action-key
state before generated keypresses; automatic HUD actions also check capture age. It never brings the game
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
network access or renderer dependency. Health is processed before mana, then R,
then T.
Captures never overlap or build up a backlog. Frames older than 120 ms are
rejected, and there is a combined limit of 240 actions per minute. Presses
start only within the first 90 ms of a frame, so when several modules fire in
the same frame (a flask, then R, then T) the later ones may wait for the next
frame; a press the worker refuses because its frame aged out is skipped, not
treated as a failure, and does not stop the loop.

Screen-derived globe percentages are estimates. Up to three short bands of
non-liquid colour inside the liquid (the globe's glossy highlight, a buff's
tint over the globe) are read as liquid, so a full globe under such effects
still reads full; an alternating noisy strip is still rejected as unreadable. Covered or unexpected-colour
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

## Manual Sigil of Power macro

In combat settings, enable **Manual Sigil macro**, then **Save & arm** or save
and press **F8**. The app waits for your physical **R** press in the game. That
press reaches the game normally, casting Sigil of Power and selecting its
weapon set. The helper sends no extra R press. It waits the configured cast
delay, taps **X** once to swap back, waits the swap delay, and taps **T** once
for Powered by Verisium.

Each physical press triggers one cycle. Holding R or pressing it again during
a cycle does not queue another cycle. After completion the macro waits for a
new R press. It never starts from a cooldown, repeats on a timer, or retries a
cast. Use it when both skills are available. Bindings are editable; the trigger
must be a letter or digit. No independent R/T automation runs while the macro
is enabled. Turning the macro off also turns both skill modules off; enable
their standalone automatic toggles explicitly if desired.

No skill calibration is needed. With both auto flasks off, the macro requires
no HUD calibration at all. Enabled auto flasks still use their calibrated
globe and fixed HUD ornament. Their settings and behavior remain independent.

The starting delays are **600 ms** after R and **100 ms** after X. These are
tunable values, not measured game minima. Set them for your character's cast
and weapon-swap animations. The macro does not confirm cast acceptance,
cooldown, animation completion or weapon-set identity. Input remains limited
to the allowlisted foreground game with the existing modifier, held-key,
emergency-stop and action-trace interlocks.

F8 pauses or arms the macro. Stop, emergency stop and losing game focus cancel
pending steps; check the weapon set before triggering another cycle. Preview
only records the intended X/T steps without sending them, but your physical R
still reaches the game normally. Pause before using in-game chat or menus.
