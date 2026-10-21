# Local GUI test stand

The current frontend is served unchanged from `src/frontend/`. A loopback HTTP model implements its request/response contracts. Automated browser requests outside that origin are blocked. No SSH, live ZFS or server mutation occurs.

`tests/gui/fixtures/server-metadata.json` is entirely synthetic: 20 invented datasets and 15 snapshots, with synthetic identifiers, properties and diagnostics. Additional `__mock__` objects cover filesystems, clones, encryption roots, volumes, ordinary directories and Jobs. No server inventory, files or encryption keys are imported.

```sh
python3 tests/gui/generate-fixture.py
npm run mock:gui
npm run test:gui
npm run test:analysis
```

Use supported Node 22/24 and Playwright Chromium. `ZFSM_CHROME` selects an optional compatible executable. The interactive server prints its local URL and resets in-memory state when restarted. `ZFSM_OUTPUT` selects the result directory; default evidence directories are ignored by Git. `ZFSM_CASE` restricts debugging to matching cases, so a subset result is not a complete report.

The main runner covers navigation, confirmations, targets, CSRF serialization, identity guards, previews, errors, File Manager, restore/ZIP contracts, Jobs pagination, responsive layouts and themes. It verifies the real UI against simulated results; it does not prove native ZFS semantics, Linux locks, authentication or physical file publication.

## Periodic refresh profiles

`ZFSM_REFRESH_INTERVAL=0` starts each HTTP-model scenario with periodic inventory refresh disabled; `30` starts it enabled. Explicit Settings scenarios may change it themselves.

```sh
ZFSM_REFRESH_INTERVAL=0 npm run test:gui
ZFSM_REFRESH_INTERVAL=30 npm run test:gui
node tests/gui/refresh-off-safety.mjs
```

Additional focused runners in this directory cover Jobs, history, modal actions, downloads, policy forms and visual geometry. Run them explicitly before claiming their coverage. A local Chromium ZIP save does not prove finalization in another application's embedded browser.

README illustrations use the separate `docs/preview/` adapter and are captured inside a Linux VM. Test output screenshots are not publication illustrations.
