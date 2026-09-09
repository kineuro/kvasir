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

## Purposes, the policy table and the organisation's key

A purpose is registered by an app in the configuration (`purposes`: `app.purpose`, its content class `catalog`, `rows` or `identifiers`, its kind `foreground` or `background`), never invented by a caller. `GET /v1/purposes` is the table the desk's models page shows: each purpose with the backend it runs on, local by default. An admin sets a backend at `PUT /v1/purposes/{id}/policy`: a `catalog` purpose opens to a remote backend by choosing one; a `rows` purpose only with `acknowledgement`, the sentence recorded under the admin's name; an `identifiers` purpose never. `POST /v1/grants` takes `{purpose, need, pin, text}` and answers the model, the backend, the measured limits and why, or refuses naming the layer that removed each candidate and the one relaxation that would admit it; a request whose text matches an identifier shape is bumped to `identifiers` and runs local whatever the table says. A stream names its purpose in `x-kvasir-purpose` or its grant in `x-kvasir-grant`; a minted key's first purpose applies unnamed; without any, a call reaches only a local backend.

The organisation's commercial key is one per provider: `PUT /v1/credentials/{provider}` (admin) stores it encrypted with XChaCha20-Poly1305 under a key held in `sealKeyFile`, outside the database, with the provider bound in as associated data; it is decrypted in memory at use, never returned, never logged; a second `PUT` rotates the row under the same seal key. A backend names its `provider` and takes the key from there.

Brought keys and the OAuth slot (C5, §8.4's third kind): a person's own provider key goes to `PUT /v1/personal/keys/{provider}` and is sealed the same way with the person's immutable subject bound in as associated data, so a row moved to another subject's name does not open; `DELETE` forgets it. An OAuth grant starts at `POST /v1/personal/oauth/{provider}/start` with the desk session and the page to return to, answers the provider's authorize URL with PKCE (S256) and a state bound to the subject and the session, and comes back on one fixed redirect on Kvasir's own origin, `GET /v1/personal/oauth/callback`, which exchanges the code with the verifier, stores access and refresh sealed under the subject, and sends the browser back to the page it came from; the refresh is rotated on every use, serialised per person and provider through a lock, and `DELETE /v1/personal/oauth/{provider}` deletes both tokens. A stream uses the person's own credential for a provider before the organisation's. `GET /v1/personal` is what the desk's settings page shows: per provider, what the person holds, and whether a personal subscription source is offered or **absent by policy** with the sentence and the date; the wave's two providers are the defaults in `oauth` of the configuration, an operator's rows replacing them by name. A machine or a minted key holds no personal credential.

## Admission (C4)

A local model is not in the catalog until it has passed the suite of Wave 4c §8.6, recorded with the date, the runtime version and the build, and re-run on every runtime upgrade. `kvasir admission run --config kvasir.json --backend ID [--model ID] [--overhead]` runs the five checks against a backend: twenty tool-call fixtures over our own schemas (vendored from the engine's MCP door in `src/fixtures/suite.ts`; validity above 0.95 passes), the chat template with a system message, an enforced schema with `minItems` where the negative control asks for a one-element clause (enforced or refused passes; accepted and ignored fails), an oversized prompt (its answer, `error`, `truncated` or `accepted`, is published as the catalog flag `overflow`), and a thinking signature's round trip (not applicable to a shape that carries none). `--overhead` adds Kvasir's own overhead: the same prompt and client straight at the backend and through this process's door, eight streams, the difference of the times to first token at p50 and p95 against the thresholds of §8.10 (50 ms and 200 ms). `kvasir admission list` prints the records; `GET /v1/admission` answers them; `POST /v1/admission/run {backend, model?, overhead?}` is an admin's. The gate is `admission.gate` in the configuration (on by default): with it on, `GET /v1/config` lists a local model only once its newest record for the runtime the backend reports now has passed; a remote backend's models are listed regardless, the suite recording their shape when run. No model judges another model's admission.
