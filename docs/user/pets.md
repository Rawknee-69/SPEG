# Pet

The pet is a small companion that lives in a corner of your window (or floats
above your desktop) and quietly reflects what your agents are doing. It is a
status signal, not a second interface: glance at it for a second and you know
whether your agent is working, waiting on you, or finished.

## What the states mean

| Pet does…              | Your agent…                                   |
| ---------------------- | --------------------------------------------- |
| breathing / blinking   | idle, nothing needs you                       |
| typing / scanning      | working                                       |
| looking at you, paw up | waiting — approval or input needed            |
| inspecting, head tilt  | finished — ready for you to review the result |
| sad, with a tear       | a task failed                                 |

The status bubble above the pet says it in words too (“Working…”, “Needs
approval”, “Ready for review”, “Task failed”). The pet never replaces the
normal notifications and task list — it is an extra, low-attention signal.

## Using the pet

- **Enable / disable**: Settings → Pets → Enable pet.
- **Move it**: drag the pet to any corner; the position is remembered.
- **Click it**: opens a small card with the followed task (open the task, open
  pet settings).
- **Right-click it**: open task, hide the pet, or jump to pet settings.
- **Hide**: right-click → Hide pet, or Settings → Pets → Show pet.
- **Reduced motion**: Settings → Pets → Reduced motion renders a static pose
  with the status bubble instead of animating.

## Which agent it follows

When several agents run at once, the pet follows the most important one:
waiting or failed agents outrank finished work, which outranks running work,
which outranks idle. Pick a different policy in Settings → Pets → Follow:
selected task, most recent, a pinned task, or the whole workspace (the bubble
then summarizes, e.g. “2 agents need you”).

## Custom pets

Pets are sprite packages you can drop in yourself:

```
my-pet/
├── pet.json          # id, displayName, description, spritesheetPath
└── spritesheet.webp  # 1536x1872 V1 atlas (8 columns x 9 rows of 192x208)
```

The V1 atlas rows are fixed, in order: idle (6), running-right (8),
running-left (8), waving (4), jumping (5), failed (8), waiting (6),
running (6), review (8). Unused cells must be transparent.

Import in Settings → Pets → Import custom pet: choose `pet.json` and the
spritesheet. The package is validated before install (dimensions, alpha,
populated frames, transparent unused cells); invalid packages are rejected
with the reason and never become selectable.

> Tip: `node scripts/generate-default-pet.mjs` regenerates the built-in pet
> and its contact sheet for reference.

## Desktop overlay

In the desktop app the pet floats in its own transparent window above your
work, so it stays visible even when the main window is hidden. It never steals
focus, stays out of the task switcher, and hides automatically while a
fullscreen window is up (Settings → Pets → Desktop overlay). You can make the
overlay click-through so it never intercepts your mouse.
