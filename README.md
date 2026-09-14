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

## License

AGPL-3.0-only, under the same [contributor license agreement](CLA.md) as the engine. See [CONTRIBUTING.md](CONTRIBUTING.md).
