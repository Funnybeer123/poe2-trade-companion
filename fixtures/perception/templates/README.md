# Perception templates

Prefer the in-app **Calibration** tab: capture, mark stash-open chrome, bag-open chrome, both grids, and the stash NPC. Looks then compare only those boxes.

CLI still works if you park the matching screen first:

```
npm run calibrate -- --label stash-open
npm run calibrate -- --label stash-closed
npm run calibrate -- --label empty-bag
npm run calibrate -- --label options
```

`stash-open` must be captured while **you can see both the stash and the bag**.

```
npm run assistive:dump
npm run assistive:deposit:run
npm run assistive:sizes
npm run assistive:sizes:learn
```

`assistive:sizes` scans the open stash and groups sprites by grid size. `assistive:sizes:learn` hovers each item, Ctrl+C copies it, and writes `fixtures/item-sizes/item-sizes.json` so later clipboard parses know `gridW` × `gridH`.
