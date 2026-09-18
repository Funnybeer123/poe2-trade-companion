# Stream Deck XL mapping

Coordinates are row,column (1-based). Pages: 1 Workflows; 2 Combat & tools; 3 Settings. Bottom-right is always Emergency stop. Bottom-left keys select the previous or next page. Every action can be dragged from PoE2 Companion in Stream Deck to reassign keys.

All buttons show idle, active (triangle), paused (bars), unavailable (barred circle), disconnected (cross) or error (!). Counts appear at the top when the service publishes them. The Property Inspector shows the exact reason. Configuration toggles show active when enabled; they stop combat just like desktop configuration.

| Page | Key | Label | Command | Icon | Function |
|---|---|---|---|---|---|
| 1 | 1,1 | RINGS | rings.gamble | [SVG](../stream-deck/assets/svg/rings.gamble-idle.svg) | One bounded batch at Ange using the existing ring policy. |
| 1 | 1,2 | CLEAN | rings.cleanup | [SVG](../stream-deck/assets/svg/rings.cleanup-idle.svg) | Rescan and sell ring rejects; buys nothing. |
| 1 | 1,3 | ID DROP | bag.workflow | [SVG](../stream-deck/assets/svg/bag.workflow-idle.svg) | Verified identification and low-priority drops. |
| 1 | 1,4 | EMPTY | transfer.empty | [SVG](../stream-deck/assets/svg/transfer.empty-idle.svg) | Deposit inventory into stash. |
| 1 | 1,5 | FILL | transfer.fill | [SVG](../stream-deck/assets/svg/transfer.fill-idle.svg) | Withdraw from the selected stash tab. |
| 1 | 1,6 | 2 CYCLE | transfer.two-cycle | [SVG](../stream-deck/assets/svg/transfer.two-cycle-idle.svg) | Existing two-cycle transfer. |
| 1 | 1,7 | PLAN | sort.preview | [SVG](../stream-deck/assets/svg/sort.preview-idle.svg) | Scan and prepare a stash sort plan. |
| 1 | 1,8 | SORT | sort.execute | [SVG](../stream-deck/assets/svg/sort.execute-idle.svg) | Execute the current validated plan. |
| 1 | 2,1 | GEAR | script.sort-gear | [SVG](../stream-deck/assets/svg/script.sort-gear-idle.svg) | Route gear using the existing sorter. |
| 1 | 2,2 | CLASS SORT | script.sort-inventory | [SVG](../stream-deck/assets/svg/script.sort-inventory-idle.svg) | Use the same class-routed inventory sorter as the Sort hotkey. |
| 1 | 2,3 | CRAFT | script.craft-gear | [SVG](../stream-deck/assets/svg/script.craft-gear-idle.svg) | Use the existing crafting planner and interlocks. |
| 1 | 2,4 | SHOP SCAN | script.shop-scan | [SVG](../stream-deck/assets/svg/script.shop-scan-idle.svg) | Scan shop and reconcile listings. |
| 1 | 2,5 | LIST | script.shop-buckets | [SVG](../stream-deck/assets/svg/script.shop-buckets-idle.svg) | Price and list inventory in merchant buckets. |
| 1 | 2,6 | SHOP LIST | script.shop-list | [SVG](../stream-deck/assets/svg/script.shop-list-idle.svg) | Existing shop listing operation. |
| 1 | 2,7 | REPRICE | script.shop-apply | [SVG](../stream-deck/assets/svg/script.shop-apply-idle.svg) | Apply the existing repricing plan. |
| 1 | 2,8 | STEP PRICE | script.shop-apply-step | [SVG](../stream-deck/assets/svg/script.shop-apply-step-idle.svg) | Reprice with existing teaching controls. |
| 1 | 3,1 | VENDOR | script.vendor-cycle | [SVG](../stream-deck/assets/svg/script.vendor-cycle-idle.svg) | Existing hideout, vendor and return workflow. |
| 1 | 3,2 | SURVEY | tabs.survey | [SVG](../stream-deck/assets/svg/tabs.survey-idle.svg) | Run the existing visible tab survey. |
| 1 | 3,3 | CAPTURE | bag.capture | [SVG](../stream-deck/assets/svg/bag.capture-idle.svg) | Capture a new bag session. |
| 1 | 3,4 | ID ONE | bag.identify | [SVG](../stream-deck/assets/svg/bag.identify-idle.svg) | Identify one item in the selected bag session. |
| 1 | 3,5 | DROP ONE | bag.drop | [SVG](../stream-deck/assets/svg/bag.drop-idle.svg) | Verify and drop one low-priority item. |
| 1 | 3,6 | RECHECK | bag.reconcile | [SVG](../stream-deck/assets/svg/bag.reconcile-idle.svg) | Reconcile the saved bag action. |
| 1 | 3,7 | VALUE | script.value-dump | [SVG](../stream-deck/assets/svg/script.value-dump-idle.svg) | Capture and value stash items. |
| 1 | 3,8 | VALUE NEXT | script.value-dump-resume | [SVG](../stream-deck/assets/svg/script.value-dump-resume-idle.svg) | Resume pending prices from the saved report. |
| 1 | 4,4 | DRY ON | safety.dry-on | [SVG](../stream-deck/assets/svg/safety.dry-on-idle.svg) | Enable shared dry-run preference. |
| 1 | 4,5 | LIVE | safety.dry-off | [SVG](../stream-deck/assets/svg/safety.dry-off-idle.svg) | Explicitly enable live execution; starts no workflow. |
| 1 | 4,6 | REARM | safety.rearm | [SVG](../stream-deck/assets/svg/safety.rearm-idle.svg) | Explicitly rearm the stopped app; starts no workflow. |
| 1 | 4,7 | STOP | workflow.stop | [SVG](../stream-deck/assets/svg/workflow.stop-idle.svg) | Cancel app workflows without rearming anything. |
| 1 | 4,8 | E STOP | safety.estop | [SVG](../stream-deck/assets/svg/safety.estop-idle.svg) | Latch the global input kill switch and cancel all app workflows. |
| 2 | 1,1 | COMBAT | combat.start | [SVG](../stream-deck/assets/svg/combat.start-idle.svg) | Start saved combat configuration. |
| 2 | 1,2 | PAUSE | combat.pause | [SVG](../stream-deck/assets/svg/combat.pause-idle.svg) | Stop combat, preserving configuration (F8 semantics). |
| 2 | 1,3 | RESUME | combat.resume | [SVG](../stream-deck/assets/svg/combat.resume-idle.svg) | Explicitly restart saved combat configuration. |
| 2 | 1,4 | END FIGHT | combat.stop | [SVG](../stream-deck/assets/svg/combat.stop-idle.svg) | Stop generated combat input. |
| 2 | 1,5 | HEALTH | combat.health | [SVG](../stream-deck/assets/svg/combat.health-idle.svg) | Toggle health automation setting; does not directly drink a flask. |
| 2 | 1,6 | MANA | combat.mana | [SVG](../stream-deck/assets/svg/combat.mana-idle.svg) | Toggle mana automation setting; preserves physical-trigger semantics. |
| 2 | 1,7 | UNLEASH | combat.unleash | [SVG](../stream-deck/assets/svg/combat.unleash-idle.svg) | Toggle Unleash configuration, preserving its trigger. |
| 2 | 1,8 | SIGIL | combat.sigilSequence | [SVG](../stream-deck/assets/svg/combat.sigilSequence-idle.svg) | Toggle the existing sequence; validation requires both skill modules. |
| 2 | 2,1 | VERISIUM | combat.verisium | [SVG](../stream-deck/assets/svg/combat.verisium-idle.svg) | Toggle Verisium configuration; does not synthesize a trigger. |
| 2 | 2,2 | LISTEN | voice.listen | [SVG](../stream-deck/assets/svg/voice.listen-idle.svg) | Listen once using saved voice settings. |
| 2 | 2,3 | MUTE | voice.cancel | [SVG](../stream-deck/assets/svg/voice.cancel-idle.svg) | Cancel recognition and its transfer. |
| 2 | 2,4 | PRICES | helper.start | [SVG](../stream-deck/assets/svg/helper.start-idle.svg) | Start calibrated price overlay. |
| 2 | 2,5 | HIDE PRICE | helper.stop | [SVG](../stream-deck/assets/svg/helper.stop-idle.svg) | Stop price overlay scanning. |
| 2 | 2,6 | REFRESH | helper.refresh | [SVG](../stream-deck/assets/svg/helper.refresh-idle.svg) | Refresh helper market data. |
| 2 | 2,7 | RUMOURS | helper.refreshRumours | [SVG](../stream-deck/assets/svg/helper.refreshRumours-idle.svg) | Refresh community rumour data. |
| 2 | 2,8 | PRICE CAL | helper.calibrate | [SVG](../stream-deck/assets/svg/helper.calibrate-idle.svg) | Start the existing helper calibration flow. |
| 2 | 3,1 | DEBUG | helper.debug | [SVG](../stream-deck/assets/svg/helper.debug-idle.svg) | Toggle overlay debug labels. |
| 2 | 3,2 | PRICE MODE | helper.prices | [SVG](../stream-deck/assets/svg/helper.prices-idle.svg) | Select price mode; explicitly start scanning afterwards. |
| 2 | 3,3 | RUMOUR MODE | helper.rumours | [SVG](../stream-deck/assets/svg/helper.rumours-idle.svg) | Select Island Rumours mode; explicitly start scanning afterwards. |
| 2 | 3,4 | EVALUATE | item.evaluate | [SVG](../stream-deck/assets/svg/item.evaluate-idle.svg) | Evaluate copied item text with the app evaluator. |
| 2 | 3,5 | BAG SCAN | scan.inventory | [SVG](../stream-deck/assets/svg/scan.inventory-idle.svg) | Run the calibrated inventory scanner. |
| 2 | 3,6 | 12 SCAN | scan.stash-normal | [SVG](../stream-deck/assets/svg/scan.stash-normal-idle.svg) | Run the normal stash scanner. |
| 2 | 3,7 | 24 SCAN | scan.stash-quad | [SVG](../stream-deck/assets/svg/scan.stash-quad-idle.svg) | Run the quad stash scanner. |
| 2 | 3,8 | REASSESS | valuation.reassess | [SVG](../stream-deck/assets/svg/valuation.reassess-idle.svg) | Re-evaluate the saved report without moving items. |
| 2 | 4,4 | DRY ON | safety.dry-on | [SVG](../stream-deck/assets/svg/safety.dry-on-idle.svg) | Enable shared dry-run preference. |
| 2 | 4,5 | LIVE | safety.dry-off | [SVG](../stream-deck/assets/svg/safety.dry-off-idle.svg) | Explicitly enable live execution; starts no workflow. |
| 2 | 4,6 | REARM | safety.rearm | [SVG](../stream-deck/assets/svg/safety.rearm-idle.svg) | Explicitly rearm the stopped app; starts no workflow. |
| 2 | 4,7 | STOP | workflow.stop | [SVG](../stream-deck/assets/svg/workflow.stop-idle.svg) | Cancel app workflows without rearming anything. |
| 2 | 4,8 | E STOP | safety.estop | [SVG](../stream-deck/assets/svg/safety.estop-idle.svg) | Latch the global input kill switch and cancel all app workflows. |
| 3 | 1,1 | HOME | open.dashboard | [SVG](../stream-deck/assets/svg/open.dashboard-idle.svg) | Open dashboard only. |
| 3 | 1,2 | CALIBRATE | open.calibration | [SVG](../stream-deck/assets/svg/open.calibration-idle.svg) | Open calibration settings only. |
| 3 | 1,3 | BAG TOOLS | open.bag-triage | [SVG](../stream-deck/assets/svg/open.bag-triage-idle.svg) | Open bag tools only. |
| 3 | 1,4 | SHOP | open.shop | [SVG](../stream-deck/assets/svg/open.shop-idle.svg) | Open shop settings only. |
| 3 | 1,5 | SETTINGS | open.settings | [SVG](../stream-deck/assets/svg/open.settings-idle.svg) | Open automation defaults only. |
| 3 | 1,6 | FIGHT CFG | open.combat | [SVG](../stream-deck/assets/svg/open.combat-idle.svg) | Open flask and skill settings only. |
| 3 | 1,7 | PRICE CFG | open.price-helper | [SVG](../stream-deck/assets/svg/open.price-helper-idle.svg) | Open price helper settings only. |
| 3 | 1,8 | TRANSFER | open.transfers | [SVG](../stream-deck/assets/svg/open.transfers-idle.svg) | Open transfer settings only. |
| 3 | 2,1 | TAB CFG | open.stash-tabs | [SVG](../stream-deck/assets/svg/open.stash-tabs-idle.svg) | Open tab survey and plan tools only. |
| 3 | 2,2 | ITEM LOG | open.items | [SVG](../stream-deck/assets/svg/open.items-idle.svg) | Open catalog and scan history. |
| 3 | 2,3 | RULES | open.search | [SVG](../stream-deck/assets/svg/open.search-idle.svg) | Open query and rule editors. |
| 3 | 2,4 | BUILDS | open.builds | [SVG](../stream-deck/assets/svg/open.builds-idle.svg) | Open build profile editor. |
| 3 | 2,5 | FILTER | open.filter | [SVG](../stream-deck/assets/svg/open.filter-idle.svg) | Open filter generation settings. |
| 3 | 2,6 | REPLAY | open.diagnostics | [SVG](../stream-deck/assets/svg/open.diagnostics-idle.svg) | Open replay and diagnostics. |
| 3 | 2,7 | HOTKEYS | open.hotkeys | [SVG](../stream-deck/assets/svg/open.hotkeys-idle.svg) | Open hotkey assignment settings. |
| 3 | 2,8 | SORT CFG | open.sort-stash | [SVG](../stream-deck/assets/svg/open.sort-stash-idle.svg) | Open stash sort preview and plan tools. |
| 3 | 3,1 | SCAN NEXT | script.value-dump-capture-resume | [SVG](../stream-deck/assets/svg/script.value-dump-capture-resume-idle.svg) | Resume the saved stash capture. |
| 3 | 3,2 | VALUE SORT | script.value-dump-sort | [SVG](../stream-deck/assets/svg/script.value-dump-sort-idle.svg) | Move using the existing valuation report. |
| 3 | 3,3 | NUMBER | script.renumber | [SVG](../stream-deck/assets/svg/script.renumber-idle.svg) | Existing tab renumber operation. |
| 3 | 3,4 | GEAR TABS | script.finish-gear | [SVG](../stream-deck/assets/svg/script.finish-gear-idle.svg) | Existing gear-tab finishing operation. |
| 3 | 3,5 | MARKET | feed.refresh | [SVG](../stream-deck/assets/svg/feed.refresh-idle.svg) | Refresh the app price feed. |
| 3 | 3,6 | HIDE | overlay.hide | [SVG](../stream-deck/assets/svg/overlay.hide-idle.svg) | Dismiss the current preview overlay. |
| 3 | 4,4 | DRY ON | safety.dry-on | [SVG](../stream-deck/assets/svg/safety.dry-on-idle.svg) | Enable shared dry-run preference. |
| 3 | 4,5 | LIVE | safety.dry-off | [SVG](../stream-deck/assets/svg/safety.dry-off-idle.svg) | Explicitly enable live execution; starts no workflow. |
| 3 | 4,6 | REARM | safety.rearm | [SVG](../stream-deck/assets/svg/safety.rearm-idle.svg) | Explicitly rearm the stopped app; starts no workflow. |
| 3 | 4,7 | STOP | workflow.stop | [SVG](../stream-deck/assets/svg/workflow.stop-idle.svg) | Cancel app workflows without rearming anything. |
| 3 | 4,8 | E STOP | safety.estop | [SVG](../stream-deck/assets/svg/safety.estop-idle.svg) | Latch the global input kill switch and cancel all app workflows. |
