# Campaign guide

*Draft of the `### Campaign guide` section for `docs/USER_GUIDE.md` (under
"## Tools & QA"). The integrator copies it in; see
`src/main/features/campaignGuide/WIRING.md`.*

---

### Campaign guide

Open it at **Tools & QA → Campaign guide**.

A levelling companion: the route for every act, the area you are standing in
right now, whether you are under- or over-levelled for it, a schematic world
map, and a small in-game panel that appears by itself while you are in the
campaign.

The guide never moves your character, never types, never clicks and never
fetches anything. It reads two kinds of line out of `Client.txt` — the
"Generating level N area" line and the level-up line — and nothing else. The
only thing it can send anywhere is a wiki link you click, which opens in your
normal browser.

**Route data is community-maintained and unverified.** Every area and every
objective in the bundled route carries `verified: false`, both screens say so,
and anything wrong can be fixed in the app (see step 7).

#### Using it

1. **Open the tool.** Without the game running it still shows the whole route;
   the "you are here" strip fills in as soon as the game writes an area line.
2. **Enter a campaign area.** The strip at the top shows the area, its act, the
   instance's own monster level, and the in-game panel appears at the edge of
   the screen (unless you turned that off).
3. **Read the current strip.** The chip is the experience estimate; the line
   under it is the suggested next step ("Next (suggested): …").
4. **Tick objectives** with the checkbox. "Reach …" objectives tick themselves
   when you walk into the area they name; un-tick one and it stays un-ticked.
5. **Filter by reward.** The chips above the acts (gems, passives, stats,
   currency, unlocks, ascendancy, league) hide objectives whose rewards you do
   not care about. Objectives with no reward tag always show. "optional" hides
   the side objectives.
6. **The map tab** draws one lane per act: main-path areas on the line, side
   areas below them, towns as squares, waypoints ringed. Click a node to read
   its card beside the map.
7. **Fix what is wrong.** "Edit area", "Add objective", "Hide", "Up"/"Down" and
   the per-area note all live on the area cards; "Add an area" is on the Edit
   tab, pre-filled when the guide met an area it does not know. Your changes
   never touch the bundled file — they live in your own settings. Two things to
   know: "Up"/"Down" swap a step with the next step you can actually see (a
   filtered-out one keeps its slot), and which act an area sits in is fixed by
   the bundled route — to move one, hide it and add it again under the right
   act.
8. **Share corrections.** Edit → "Copy route JSON" exports the merged route
   (your edits folded in). "Import (merge)" and "Import (replace my edits)"
   read someone else's JSON back in as your corrections. Imports over 2 MB are
   refused.
9. **`Alt+G`** toggles the in-game panel (rebind it under Tools → Hotkeys).
10. **Guide settings** (at the bottom of the tool) hold the five preferences:
    show automatically in campaign areas, hide when leaving the campaign,
    overlay position, compact overlay, and a character-level override.

#### The experience chip

XP percentages are estimates from the community formula, never a guarantee —
the tool, the area cards and the in-game panel all say so. The area level used
is the instance's real monster level, not a table value. The chip appears for
campaign areas only: a hideout's or a map's level is not something to compare
your character against, so no estimate is shown there.

| Chip | Meaning |
|---|---|
| safe (green) | On level, or losing at most ~10 % experience |
| warning (amber) | Roughly 50–90 % experience — you are drifting off level |
| danger (red) | Under 50 % experience, or under-levelled by more than the safe zone + 3 |

The character level comes from the last level-up line in the log. If the app
started long after your last level-up, press **Rescan log (16 MB)** or type the
level into the override box.

#### The in-game panel

The panel is pinned: <kbd>Escape</kbd> and "Hide all overlay panels" leave it
alone. The × hides it until you enter another area. It disappears by itself
when you leave the campaign (if "Hide when leaving the campaign" is on) or when
the game closes, and comes back the next time you enter a campaign area. It
never takes keyboard focus and never captures the mouse from the game.

#### If something looks wrong

| Symptom | What to try |
|---|---|
| "No area seen yet" | Set the Client.txt path under Tools → Settings; the guide only reads, it never writes there |
| Character level unknown | "Rescan log (16 MB)", or type the level into the override |
| The panel does not appear | Check "Show automatically in campaign areas", that the game is detected, and that "Hide when leaving the campaign" did not just hide it |
| Wrong area name, level or boss | Edit it on the area card, then export the JSON so the correction can go into the bundled route |
| An area is missing entirely | The strip offers "Add this area" with the id, act and level pre-filled |

#### Where the data lives

`%APPDATA%\poe2-trade-companion\companion-settings.json`, namespace
`campaign-guide`: your route corrections, ticked objectives and visited areas.
Only area ids and timestamps are stored — no log text, no character data beyond
the level, nothing leaves this PC. "Visited" covers campaign areas only:
hideouts, maps and league areas are not progress and are never written down.

#### What it will not do

No quest automation, no waypoint travel, no walking, no chat. The guide tells;
you play.
