# Kvasir

**The model gateway of NILS.** One service, one database, one process. It authenticates a caller and resolves it to a principal with roles; answers "what model can serve this need" or refuses with reasons; streams a model response holding the credential, counting tokens and enforcing caps; and records who spent what, in counts. Every part of NILS that talks to a model talks to Kvasir.

It is not an agent runtime, not a model host, not a second user directory, not a prompt log, not a clever router and not a general egress proxy (`kineuro/nils`, `docs/specs/wave4c-the-assistant.md`, §8.1).

> **Pre-alpha.** Built in the open as part of Wave 4c of NILS v1. The door speaks `pi-messages`, pi's own protocol, on the version of `@earendil-works/pi-ai` that Flue pins, exactly.

## Where things are

| | |
|---|---|
| [`kineuro/nils`](https://github.com/kineuro/nils) | The engine, the design record, the specification (§8) and the contracts (`contracts/suite`) this gateway is built against. |
| `src/` | The service: the doors, the backends and their health, the catalog. |
| `test/` | Vitest, against fake backends. |
| `kvasir.example.json` | The configuration: the door, identity (`off`, `token`, or `oidc` with a trust list and a group to role map, the engine's own), the store, the admission queue, the backends. |

## Running it

```sh
npm ci && npm run build
cp kvasir.example.json kvasir.json   # edit the backends
node dist/main.js --config kvasir.json
```

## License

AGPL-3.0-only, under the same [Contributor License Agreement](CLA.md) as the engine.

## Identity, keys, the ledger

Identity is the engine's: the same three modes, the same ladder, the same trust list, verified against the shared vectors of `contracts/suite/v1` (vendored under `test/vectors/`). A caller with no mapped role is refused everywhere. An admin mints keys at `POST /v1/keys` (`kvs_`, thirty-two random bytes shown once, stored as a keyed BLAKE2b hash under a pepper the service makes at first start, compared in constant time) with a principal, a purpose allowlist, a maximum content class and an expiry; a key with no purpose reaches only local backends; `DELETE /v1/keys/{id}` deletes the row. The ledger (`GET /v1/ledger`, one's own rows, every row for an admin) is one row per stream in counts, with no content column, and `GET /metrics` carries the same rule. Each backend admits its configured streams at once, queues eight behind them with a heartbeat on the socket, and refuses the rest at the `health` layer, as it does after sixty seconds of waiting.
