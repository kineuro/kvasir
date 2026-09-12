# Changelog

All notable changes to Kvasir are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, pre-releases are `1.0.0-alpha.N`.

## [Unreleased]

## [1.0.0-alpha.2] - 2026-09-12

### Changed

- A token written in `auth.tokens` opened the gateway only in token mode. It now works beside a trust list as well, so an installer that has the gateway trust an issuer, such as the desk, keeps its own way in to the admin doors it uses, for example to mint the assistant's key. Any other caller still brings a token from a trusted issuer or a minted key, and off mode is unchanged.

## [1.0.0-alpha.1] - 2026-09-12

### Security

- The seal key that encrypts stored provider keys, keys people bring and their OAuth grants was committed to this repository, so every install that ran Kvasir from a clone sealed its secrets under a key anyone could read. The file is no longer in the repository. At start, Kvasir replaces a seal key equal to the published one with a new private key and seals every stored secret again under it; where an update removed the file, the new key is made and the secrets carry over. If a copy of the database may have left your machines, replace the provider keys stored in it.
- `POST /v1/chat/completions` reached any backend without a purpose, the policy table, the queue or the ledger. It now goes the way `POST /v1/messages` goes: a remote backend needs a purpose whose policy allows it, text with an identifier shape keeps the call local, every call waits its turn in the backend's queue, and every call is one ledger row.
