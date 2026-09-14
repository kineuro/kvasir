# Changelog

All notable changes to Kvasir are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, pre-releases are `1.0.0-alpha.N`.

## [Unreleased]

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
