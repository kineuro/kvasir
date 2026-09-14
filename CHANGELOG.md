# Changelog

All notable changes to Kvasir are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, pre-releases are `1.0.0-alpha.N`.

## [Unreleased]

## [1.0.0-alpha.6] - 2026-09-14

### Fixed

- A stream through Kvasir no longer goes quiet while the model reads a long prompt. Both doors write a comment on a stream that has said nothing for 15 seconds, which no reader of an event stream takes as an event, so a caller's HTTP client keeps the response: Node's fetch ends one that says nothing for 300 seconds. On the processor, llama.cpp read a 5,571-token prompt of the assistant's for 426 seconds before its first token, and the turn failed as "terminated" with nothing written.

## [1.0.0-alpha.5] - 2026-09-14

### Added

- Kvasir starts the GGUF models it downloaded (record 24). Where kvasir.json names the install's runtime in `local.runtime`, llama.cpp's server in router mode that the install runs as a service with no model loaded (its address, key file, presets file, log, build and variant), a finished GGUF download starts with `POST /v1/local/models/{id}/start` or `kvasir local start --id N`, and stops with `POST /v1/local/models/{id}/stop` or `kvasir local stop --id N`. Kvasir writes the model's preset (an 8-bit KV cache, its own chat template, a downloaded vision projector with it, and a context of the model's own or 32,768 tokens, whichever is smaller, read from the GGUF file's header, or the context a start names with `context` or `--context N`, from 4,096 tokens up to the model's own), has the runtime read its presets again and load the model, and follows it. Loaded, the model is held on the backend `llama-cpp`, warmed and admitted as any local model, with the context and slots the runtime settled on; failed, its row keeps the exit status and the last lines the runtime logged for it. One model runs at a time, so starting another stops the one running. Where the runtime computes on the processor, a start first reckons the memory the load needs (the model's files, its cache for that context, and a gibibyte to spare) against what the machine has free, the least of its available memory and the room any memory limit above Kvasir leaves: it halves the context, down to 8,192 tokens, where that is enough, and says so in the run's `note`, and otherwise refuses the start with `not_enough_memory` and the numbers. What an admin started is kept in the database: a model that was serving is loaded again, once, when Kvasir or the runtime starts again, and a load the runtime did not survive, as when the kernel stops it for lack of memory, is left failed and never asked for again until an admin starts it. A start from the command line is carried on by a Kvasir serving the database. A start is refused with `no_runtime`, `not_downloaded`, `not_gguf`, `runtime_unreachable` or `not_enough_memory`, and a started model is not removed until it is stopped. `GET /v1/local` shows the runtime (its build, whether it answers, and the model it serves) and, for each model, whether it starts and its run. A GGUF download on an install with a runtime no longer lists the llama.cpp and Ollama commands.
- `hostAlias` in kvasir.json, for a Kvasir that runs in a container: a model server added or tried at a loopback address (127.0.0.1, localhost or [::1]) is reached by that name for the machine, the way setup writes such an address, and the answer says so.

### Changed

- While admission's gate holds, a local model that has not passed admission is no purpose's default. A purpose whose only local model is still in admission, or was refused by it, is refused with that model named.
- A Kvasir serving the database follows a held backend whose models another Kvasir changed, as it follows one added or removed.

### Fixed

- Kvasir no longer warms its own ChatGPT backend when it starts. With no subscription to warm it with, the try only left an error in its health. The line Kvasir starts with counts only the models an admin added.

## [1.0.0-alpha.4] - 2026-09-14

### Added

- ChatGPT through a person's own subscription. A person signs in with a device code (`POST /v1/subscriptions/chatgpt/sign-in`, then `GET /v1/subscriptions` until it is signed in), chooses the model their streams use (`PUT /v1/subscriptions/chatgpt`) and signs out (`DELETE /v1/subscriptions/chatgpt`). The credential is sealed under that person and refreshed before it expires. Where nobody signs in, the subscription signed in is the install's, and `kvasir subscriptions sign-in` signs it in from the command line. Kvasir's own `chatgpt` backend streams through pi-ai's OpenAI Codex adapter with the token of whoever streams. A purpose an admin moves to it goes to that person's subscription, runs on the local default for someone with none signed in, needs the written reason when it carries rows, and never carries identifiers.
- An app's key calling for a person names them in `x-kvasir-person` with the person's own token, which Kvasir verifies as it would the person's own call. That person's subscription is used and the ledger row is theirs; a token that does not verify is refused.
- Local models, downloaded by Kvasir from the Hugging Face Hub into a location an admin can change. A lookup lists the files a model would bring and their sizes, and keeps nothing (`POST /v1/local/lookup`, `kvasir local lookup`). A download is queued (`POST /v1/local/models`, `kvasir local download`) and brought one file at a time into `<location>/<owner>--<name>/<commit>/`, each file resumed from what it holds and checked against the sha256 the hub lists. It is paused, resumed, and removed with its files (`POST /v1/local/models/{id}/pause`, `POST /v1/local/models/{id}/resume`, `DELETE /v1/local/models/{id}`), and refused where the location has less room than it still needs and a gibibyte more. `GET /v1/local` and `kvasir local list` show every model with its size, its state and the commands SGLang, vLLM, llama.cpp or Ollama serve it with; Kvasir runs none of them. The location is a setting in Kvasir's database, `models` beside the database until an admin changes it (`PUT /v1/local/location`, `kvasir local location --set`), and a model downloaded before stays where it is. A gated or private model needs a Hugging Face token, sealed with the other credentials under `huggingface`, a name no backend takes, and never shown (`PUT /v1/local/token`, `DELETE /v1/local/token`, `kvasir local token`). A download that Kvasir closing stops carries on when Kvasir starts again. One the command line starts is left to a Kvasir serving the same database when one takes it, and two Kvasirs never download at once. `local.endpoint` in kvasir.json names a mirror of the hub.

### Changed

- A second Kvasir on the database, such as the command line beside a running server, waits up to five seconds for its turn to write instead of failing at once.
- Kvasir holds its models in its own database. An admin tries a server's models (`POST /v1/backends/test`, `kvasir models test`), adds a backend (`POST /v1/backends`, `kvasir models add`), which is held only once every one of its models answered one short request, and removes one (`DELETE /v1/backends/{id}`, `kvasir models remove`), which lets go of its key and of the policy rows that named it. A local backend added while Kvasir runs is warmed and admitted there, and one added from the command line is followed within seconds. A backend's key is sealed under the backend's own id. `GET /v1/backends` shows an admin each backend's address and who added it, and everyone each model's window and admission.
- `kvasir.json` no longer takes `backends` or `oauth`, and refuses a file that still names them: a fresh Kvasir starts with no model. `kvasir keys list` and `kvasir keys revoke` join `kvasir keys mint`.
- Kvasir's version is read from its package; the constant said 1.0.0-alpha.2.
- A purpose the policy table maps elsewhere moves a call to where the table sends it, whatever model the caller named, and the grant says so. A caller naming a model on another backend was refused.

### Removed

- The personal credentials of the first design: a key a person brought, and an OAuth grant through a redirect to Kvasir's own address, with their doors and tables.
- The migration of the seal key published with the source before 1.0.0-alpha.1.
- The `--streams` and `--rounds` flags that `kvasir admission run` named and never read.

### Fixed

- A local backend whose warm-up failed at start is tried again until it answers: after five seconds, then waits doubling to a minute, then every minute. One failed try, a network not up yet at boot or a model still loading, used to leave the backend warming, and every request to it refused, until Kvasir was started again.

## [1.0.0-alpha.3] - 2026-09-14

### Added

- A backend's text is read for reasoning its model left inline, so a runtime that does not separate reasoning, or a model whose markers it does not know, still hands the client its thinking and its answer apart. Kvasir reads the markers of each family when they open the output: `<think>`, Gemma 4's `<|channel>thought`, gpt-oss's harmony channels, Mistral's `[THINK]`, Cohere's `<|START_THINKING|>`, Kimi K3's think channel and the namespaced think tags. It holds back the end of the text while that could still become a marker, never goes back into reasoning once the answer has begun, and drops the stop tokens a runtime leaves at the end. `inlineReasoning` on a backend says how its text is read: `markers`, the default; `open`, for a chat template that opens thinking in the prompt, so the output begins inside it; or `off`. Both doors carry the result: thinking events on `POST /v1/messages`, and `reasoning_content` on `POST /v1/chat/completions`.

### Fixed

- A turn a client sent back through `POST /v1/messages` carried the client's own provider and Kvasir's catalog id, so pi took it for another model's turn and pasted its thinking into the text of the answer, where the model read its old reasoning as something it had said. A turn the requested model wrote now goes to the backend as that backend's own, so its thinking replays as thinking, signature and all, and thinking another model wrote is left out.

## [1.0.0-alpha.2] - 2026-09-12

### Changed

- A token written in `auth.tokens` opened the gateway only in token mode. It now works beside a trust list as well, so an installer that has the gateway trust an issuer, such as the desk, keeps its own way in to the admin doors it uses, for example to mint the assistant's key. Any other caller still brings a token from a trusted issuer or a minted key, and off mode is unchanged.

## [1.0.0-alpha.1] - 2026-09-12

### Security

- The seal key that encrypts stored provider keys, keys people bring and their OAuth grants was committed to this repository, so every install that ran Kvasir from a clone sealed its secrets under a key anyone could read. The file is no longer in the repository. At start, Kvasir replaces a seal key equal to the published one with a new private key and seals every stored secret again under it; where an update removed the file, the new key is made and the secrets carry over. If a copy of the database may have left your machines, replace the provider keys stored in it.
- `POST /v1/chat/completions` reached any backend without a purpose, the policy table, the queue or the ledger. It now goes the way `POST /v1/messages` goes: a remote backend needs a purpose whose policy allows it, text with an identifier shape keeps the call local, every call waits its turn in the backend's queue, and every call is one ledger row.
