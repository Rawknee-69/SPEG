# Running SPEG in the Background

On a Linux host, SPEG can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

## Manage the Service

Install it with the latest SPEG release:

```sh
npx speg@latest service install
```

Check whether it is installed:

```sh
npx speg@latest service status
```

Update or repair it:

```sh
npx speg@latest service update
```

Stop it and remove it from startup:

```sh
npx speg@latest service uninstall
```

Updating restarts SPEG briefly. Let active agent work and terminal commands finish first.

The systemd unit runs a small stable launcher. Exact SPEG versions are installed separately, so
a failed remote candidate can return to the previous version without rewriting the unit. Releases
that change the database must be installed with the local `service update` command above.

## Using It with SPEG Connect

SPEG Connect may offer to install the service during setup so the host stays reachable after you log
out. This is only an onboarding shortcut: the service and SPEG Connect are managed separately.

Signing out of SPEG Connect does not remove the service. Use `speg service uninstall` when you no longer
want SPEG to start in the background.

The background service currently requires Linux with systemd.
