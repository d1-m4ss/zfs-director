# Frontend → PHP integration

Use supported Node 22/24. The actual PHP page, endpoint, validators, signing, configuration persistence, journals and job runner execute inside a private PHP/WASM filesystem. HTTP form bodies are passed to PHP's request parser. Every automated browser request outside the loopback stand is blocked.

```sh
npm run test:integration
# Optional interactive inspection:
npm run mock:php
```

All datasets, GUIDs, files, mounts and system results are generated test data. No host storage or real server is accessed. Virtual adapters replace external process calls, Perl helper execution, streaming/download boundaries and worker launch. Unhandled system commands fail. A POSIX error-string shim supplies an extension absent in WASM; GLOB_BRACE patterns are expanded separately.

Coverage includes HTTP/CSRF/array parsing, settings serialization, property confirmation/readback, creation and reviewed deletion contracts, replay rejection, encryption request contracts and secret transport, File Manager filtering/pagination, signed restore/ZIP queueing, simulated Job lifecycles and persistent history. `ZFSM_REFRESH_INTERVAL=0` or `30` sets the initial refresh profile. `ZFSM_OUTPUT` selects an ignored output directory.

Reports record the supplied source revision/tree label (or `working-tree`), source-dirty status, results and errors. Optional `ZFSM_SOURCE_REVISION` and `ZFSM_SOURCE_TREE` label a separately verified checkout. A passing WASM test does not prove kernel mounts, flock/fsync durability, native rsync/ZIP semantics or real ZFS operations.
