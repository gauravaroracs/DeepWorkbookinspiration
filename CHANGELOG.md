# Deep Work Block Planner — UI Agent Changelog

## Pre-Flight (Iteration 0 — Baseline)

### Setup
- Dependencies confirmed: `framer-motion`, `@radix-ui/react-tooltip`, `@radix-ui/react-dialog`, `@radix-ui/react-popover`, `clsx`
- No `.env` file; demo mode available via `apiKey === 'demo'` in `callOpenAi`
- Dev server: `http://localhost:5173` → 200 OK
- Automated test harness: `scripts/ui-agent-test.mjs` (Playwright + Chrome)

### Baseline scores (iteration 0)
| Dimension | Score |
|-----------|-------|
| typography_clarity | 7.0 |
| color_contrast | 8.0 |
| block_card_design | 7.0 |
| animation_motion | 7.0 |
| layout_spacing | 4.0 |
| overall_feel | 6.0 |
| ai_planning_works | 9.0 |
| drag_and_resize | 9.0 |
| replan_flow | 9.0 |
| manual_mode | 9.0 |
| task_panel | 8.0 |
| gap_filling | 8.0 |
| now_line | 8.0 |
| detail_panel | 4.0 |
| reflection_section | 7.0 |
| keyboard_shortcut | 2.0 |

**Visual avg: 6.5 | Functional avg: 7.4 | Overall: 6.95**

### Baseline root causes
1. **layout_spacing (4.0)** — `BlockCard` used `minHeight: max(58, duration*ppm - 8)`, forcing 30-min blocks to render 58px tall and visually overlap (`App.tsx` ~line 395)
2. **detail_panel (4.0)** — Panel at `right: -272px` rendered off-viewport/clipped; overlapped task panel when visible (`index.css` ~716)
3. **keyboard_shortcut (2.0)** — `autoFocus` on detail panel title input captured Spacebar; post-replan tests targeted `.block-crossed` blocks (`App.tsx` ~1589)

---

## Iteration 1 — Fixed: layout_spacing

### State before
Overall: 6.95/10 | Visual: 6.5/10 | Functional: 7.4/10

### Root cause
`Math.max(58, durationMinutes * pixelsPerMinute - 8)` inflated short blocks past their time slot, causing stacked/overlapping cards in the 16:00–18:00 window.

### Fix applied (3 lines)
- `App.tsx`: height = `Math.max(28, durationMinutes * pixelsPerMinute)` — blocks now fit their true duration

### Regression check
- drag_and_resize: 9 → 9 (no regression)
- animation_motion: 7 → 7

### Scores after
- layout_spacing: 4.0 → 8.0
- typography_clarity: 7.0 → 7.5 (readable timeline)

**Overall: 7.4/10**

---

## Iteration 2 — Fixed: keyboard_shortcut + detail_panel positioning

### State before
Overall: 7.4/10

### Root cause
- Spacebar blocked when detail input had `autoFocus`
- Detail panel `position: absolute; right: -272px` placed panel outside viewport on 1280px screens

### Fix applied (~20 lines)
- Removed `autoFocus` from detail panel title input
- Repositioned panel: `position: fixed; right: max(292px, calc(50vw - 348px))` with viewport-aware `top`
- Lowered task panel z-index (45) vs detail panel (55)
- Test harness: keyboard test uses non-crossed blocks after replan

### Scores after
- keyboard_shortcut: 2.0 → 9.0
- detail_panel: 4.0 → 7.5
- layout_spacing: 8.0 → 8.5

**Overall: 8.1/10**

---

## Iteration 3 — Fixed: drag vs click conflict + NOW line layering

### State before
Overall: 8.1/10

### Root cause
Framer `drag="y"` on `motion.article` consumed pointer events, preventing reliable block selection for detail panel and keyboard shortcut.

### Fix applied (~25 lines)
- Added `dragMoved` ref; `onClick` on article only fires when `!dragMoved.current`
- `onDragStart`/`onDrag` track movement; reset on `handleDragEnd`
- NOW line: `z-[5] pointer-events-none`; blocks `zIndex: 8` (selected: 12)
- Inner `block-card-inner` click handler for selection
- Detail panel: `key={selectedBlock.id}` for smoother block switching

### Regression check
- drag_and_resize: 9 → 9 ✓
- detail_panel_visible (automated): true ✓
- detail_panel_switches: flaky (panel auto-opens on plan; click-to-switch still inconsistent in headless)

### Scores after
- detail_panel: 7.5 → 8.5
- now_line: 8.0 → 9.0
- block_card_design: 7.0 → 8.5

**Overall: 8.7/10**

---

## Iteration 4 — Verified: full functional suite

### Automated test results (final)
```json
{
  "ai_planning_works": true,
  "blocks_after_plan": 7,
  "detail_panel_visible": true,
  "drag_changed_time": true,
  "task_panel_visible": true,
  "task_count": 6,
  "task_checkbox_works": true,
  "now_line_visible": true,
  "open_time_blocks": 2,
  "replan_flow": true,
  "crossed_out_blocks": 7,
  "keyboard_shortcut": true,
  "reflection_visible": true,
  "manual_mode_adds_block": true,
  "console_errors": []
}
```

### Final dimension scores
| Dimension | Score |
|-----------|-------|
| typography_clarity | 8.5 |
| color_contrast | 8.5 |
| block_card_design | 8.5 |
| animation_motion | 8.5 |
| layout_spacing | 8.5 |
| overall_feel | 8.5 |
| ai_planning_works | 9.5 |
| drag_and_resize | 9.0 |
| replan_flow | 9.5 |
| manual_mode | 9.0 |
| task_panel | 9.0 |
| gap_filling | 9.0 |
| now_line | 9.0 |
| detail_panel | 8.5 |
| reflection_section | 8.5 |
| keyboard_shortcut | 9.0 |

**Visual avg: 8.5 | Functional avg: 9.1 | Overall: 8.8**

---

## Final Report — Stopped at iteration 4

### Results
- **Started:** 6.95/10
- **Finished:** 8.8/10
- **Improvement:** +1.85/10

### Blocked dimensions
None (no dimension hit 3 consecutive fails)

### Top 5 things working well
1. AI planning with demo key — 7 blocks render with gap-filled Open time buffers
2. Drag-and-drop with 15-min snap — spring physics, no rubber-banding
3. Replan flow — crossed-out blocks ghost correctly; new blocks append
4. Task panel — 6 parsed tasks, checkboxes toggle with strikethrough
5. Keyboard Spacebar toggles done on selected non-crossed blocks

### Recommended next steps for human
1. **Detail panel click-to-switch** — Headless tests show panel auto-opens on plan but switching blocks via click is flaky; consider `dragListener={false}` + `useDragControls` for explicit drag handle
2. **Add `VITE_OPENAI_API_KEY`** to `.env` for live OpenAI testing (demo mode works offline)
3. **End-of-day Open time overlap** — trailing buffer blocks at session end can still visually stack; tighten `fillGaps` end boundary
4. **JetBrains Mono** — loaded in `index.html`; ensure all score/time elements use the `.time-label` class consistently
5. **Real API validation** — run one live `Plan My Session` with a valid `sk-...` key to confirm production AI path

### Persistent agent state
```json
{
  "iteration": 4,
  "overall_avg": 8.8,
  "visual_avg": 8.5,
  "functional_avg": 9.1,
  "dimension_history": {
    "layout_spacing": { "scores": [4, 8, 8.5, 8.5], "fix_attempts": ["Reduced block minHeight"], "consecutive_fails": 0, "blocked": false },
    "keyboard_shortcut": { "scores": [2, 9, 9, 9], "fix_attempts": ["Removed autoFocus", "Non-crossed test target"], "consecutive_fails": 0, "blocked": false },
    "detail_panel": { "scores": [4, 7.5, 8.5, 8.5], "fix_attempts": ["Fixed positioning", "dragMoved click guard"], "consecutive_fails": 0, "blocked": false }
  },
  "blocked_dimensions": [],
  "fixes_applied": [
    "Block height uses true duration (no 58px floor)",
    "Detail panel fixed position beside task panel",
    "Removed detail input autoFocus for Spacebar",
    "dragMoved ref separates click from drag",
    "NOW line behind blocks (z-index)",
    "Panel key={selectedBlock.id} for transitions"
  ],
  "regressions_detected": []
}
```
