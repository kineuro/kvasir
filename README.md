# Kvasir

**The model gateway of NILS.** Every call the NILS assistant makes to a model goes through Kvasir. It holds the models' credentials, decides which model may serve which purpose and whether that purpose may leave the machine, and records who spent what, in counts and never the content.

It is part of [NILS](https://github.com/kineuro/nils). It is not a model host: it sits in front of a model server you run, such as SGLang, vLLM, llama.cpp or Ollama, or a commercial provider.

> **Pre-alpha.** Kvasir installs and runs, and its interfaces still change between releases.

## Install

The NILS setup wizard installs Kvasir with the assistant, adds the model you name once it answers, and makes the assistant's key:

```sh
curl -fsSL https://nils.kineuro.se/get | sh
```

## Documentation

**[kineuro.se/nils/docs](https://kineuro.se/nils/docs/)**

- [What the assistant is made of](https://kineuro.se/nils/docs/assistant/what-it-is/), and why a gateway at all
- [The model and the gateway](https://kineuro.se/nils/docs/assistant/kvasir/): serving a model, adding it to Kvasir, and minting a key

## The parts of NILS

| Repository | Part |
|---|---|
| [kineuro/nils](https://github.com/kineuro/nils) | The engine: the registry, the rule packs, the `nils` command and the setup wizard. Everything else talks to it. |
| [kineuro/nils-desk](https://github.com/kineuro/nils-desk) | The desk: the web application over the engine, and where people sign in. |
| [kineuro/nils-assistant](https://github.com/kineuro/nils-assistant) | The assistant: turns a question in words into one the engine answers. |
| **kineuro/kvasir** | The model gateway: every call the assistant makes to a model goes through it. |

## Building from source

```sh
npm ci && npm run build && npm test
cp kvasir.example.json kvasir.json
node dist/main.js models add --url http://127.0.0.1:30000/v1 --locality local --model qwen38-27b --config kvasir.json
node dist/main.js --config kvasir.json
```

`src/` is the service, `test/` its tests against fake backends, and `kvasir.example.json` the configuration with every setting. The models are not in it: Kvasir holds them in its database, and adds each one from the desk or with `kvasir models add` once it answers.

Callers hold grants, as everywhere in NILS: a trusted token's `grants` claim, or what `auth.roles` binds a group to and a token in `auth.tokens` lists, each a grant or a ladder step that stands for its set. `kvasir:work` opens the doors that change Kvasir, and a person's own ChatGPT subscription needs `assistant:use` and `kvasir:see`. A trust entry with `keepSubject: true`, the desk's own as setup writes it, takes a subject that already holds `@` as the principal; any other entry qualifies it by the issuer's host.

## Serving clients outside NILS

Kvasir can also be the group's model server: one address and one key per client for OpenAI- and Anthropic-shaped clients such as Droid or a script. A backend added with `--pass-through chat-completions,completions,messages,responses` answers those doors as the client sent them, with only the model's name changed. `GET /v1/models` lists each model with its specs.

```sh
node dist/main.js keys add --name droid --config kvasir.json
node dist/main.js keys import --modelgate /etc/modelgate/keys --config kvasir.json
node dist/main.js keys list --config kvasir.json
```

A client key opens only the doors in `public.doors`; `public.bind` serves those alone on a listener of their own. NILS's assistant streams through `/v1/pi/messages`.

## Local models

Kvasir downloads a model from the Hugging Face Hub into a location an admin can change, resumes a download where it stopped, checks each file against the hub's sha256, and lists every model with its size, its state and the commands that serve it. It runs no model: start your model server on the download, then add that server as any other.

```sh
node dist/main.js local download --repo OWNER/NAME --include "*Q4_K_M.gguf" --config kvasir.json
node dist/main.js local list --config kvasir.json
```

## A card, and a model server as a backend

A Kvasir with `cards` in its configuration serves a group of models that share one GPU, one loaded at a time, as `kvasir.card.example.json` shows. Asking for the model that is not loaded swaps it in: Kvasir lets the running requests finish, stops the loaded model, starts the other and waits for its health, and goes back to the default after a while without use. The models run as SGLang containers Kvasir starts and stops by name (`"driver": "docker"`), or as presets of a llama.cpp router (`"driver": "llama-router"`). `GET /health` says which model is loaded.

Another Kvasir uses such a server as one backend, by its address and key. It lists the models with their specs, and admits the ones you name one by one:

```sh
node dist/main.js models add --server https://models.example.org/v1 --key-file server.key --config kvasir.json
node dist/main.js models add --server https://models.example.org/v1 --key-file server.key --model qwen38-27b --config kvasir.json
```

## License

AGPL-3.0-only, under the same [contributor license agreement](CLA.md) as the engine. See [CONTRIBUTING.md](CONTRIBUTING.md).
