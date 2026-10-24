# Kitchen Renovation Schedule

A shared, read-only Gantt chart for the kitchen renovation. Anyone with the link can view it on a phone or computer, with no login required.

**Live page:** https://route3ralph.github.io/kitchen-renovation/

- `index.html` is the page. You shouldn't need to touch it.
- `schedule.js` holds the schedule data. **This is the only file you edit.**

## Updating the schedule (≈2 minutes)

1. Open [`schedule.js`](schedule.js) and click the pencil icon (✏️ Edit).
2. Make your change. The common edits are:
   - **Mark progress:** add `status: 'done',` or `status: 'in-progress',` or `status: 'delayed',` to a task.
   - **Lock in a confirmed date:** add `start: '2026-12-02',` to a task.
   - **Change a duration:** edit `days: 3` (working days) or `weeks: 6` (calendar weeks).
   - **Name a contractor:** edit the `who:` field under `trades`.
3. Update `updated:` near the top to today's date.
4. Click **Commit changes**. The live page refreshes within a minute or two.

Downstream dates recalculate automatically. If cabinets slip a week, everything that depends on them moves too. If the file has a typo, the page says so instead of going blank. Fix the last change and commit again.

## Sharing

- **Everyone:** send the live page link.
- **One trade:** click a trade's filter chip, then **Copy link**. The link opens with only that trade's tasks showing (for example `…/kitchen-renovation/?trade=electrician`).
- **Critical path:** tick the checkbox to see which tasks move the finish date if they slip.

## Publishing (one-time setup)

Settings → Pages → Source: **Deploy from a branch** → Branch: **main**, folder **/ (root)** → Save.

## Privacy

This repository and the page are public. Don't put door or alarm codes, your address, phone numbers, or budget figures in `schedule.js`. Before editing on github.com, turn on *Settings → Emails → Keep my email addresses private* so your email isn't attached to your edits.
