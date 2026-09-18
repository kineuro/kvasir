# Contributing

kvasir is pre-alpha and developed in the open, beside the engine. Issues, questions and pull requests are welcome from the first commit.

## Before you start

- The design lives in the engine repository: the decision record in `kineuro/nils/docs/decisions/` and the wave specification in `kineuro/nils/docs/specs/wave4c-the-assistant.md`. A change that touches a decision cites it.
- Open an issue before a large change, so the direction is agreed before the code exists.
- Never put patient data in an issue, a pull request, a test or a fixture: no names, no identifiers, no UIDs, no folder paths from a clinical system. Counts and shapes are fine.

## How work flows

- `main` is protected. Code lands by pull request with a green CI run, rebased onto `main` (linear history, no merge commits).
- Commit messages say what changed and why, in prose, and cite the specification section or decision id when there is one.
- Every source file starts with an SPDX header, `// SPDX-License-Identifier: AGPL-3.0-only`.
- Work is grouped into waves, and a wave is tried on a real machine through a development channel rather than through a tag: a build of the integration branch, labelled `1.0.0-alpha.N.dev.M` and served on a loopback address, which an install takes as it takes a release. The full description is in the engine repository, `kineuro/nils/CONTRIBUTING.md`.
- Kvasir carries its own tags and its own numbers. The installer takes it at a pinned tag, and that pin moves in an engine release; a wave that changes Kvasir points the installer at a branch for the test, with `NILS_SETUP_KVASIR_REF`.
- Kvasir is TypeScript on Node 22, on the pi-ai version Flue pins. CI checks, tests and builds it.

## Licensing your contribution

Everything here is [AGPL-3.0-only](LICENSE). A contribution needs the [NILS Contributor License Agreement](CLA.md), signed once for every NILS repository. On your first pull request a bot asks for it; sign by posting this comment on the pull request:

```text
I have read the CLA Document and I hereby sign the CLA
```
