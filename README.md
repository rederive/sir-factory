# sir-factory

The **mechanical CLI** of the SIR verified-recompose factory. It does the deterministic steps — install a package, stamp a held-out oracle, grade emissions against the dual gates, pack a verified bundle. It does **not** call `claude -p` or use an API key: the *orchestrating agent* (`sir-factory-runner`) drives the loop and spawns the role agents (sighted decomposer, blind re-emitters) via the Agent tool. Targets **SIR Schema v0.2** (`KIND STATE` `{result,post}` oracles, `specVersion`-stamped bundles).

> This is the engine the [`sir` Claude plugin](https://github.com/rederive/sir-toolkit) depends on. Verification of a packed bundle is done by **`rdv`** (the `rederive` CLI).

## Install

```
npm i -g sir-factory          # exposes `sir-factory`
```

## Subcommands

```
sir-factory install <pkg@ver> <unit> [--out DIR]   scaffold a workdir; print the sighted-decompose next step
sir-factory stamp   <wd>                            run the real package → frozen + held-out oracle (KIND STATE ⇒ {result,post})
sir-factory stage-reemit <wd>                        stage the clean room (SIR + frozen oracle; original absent)
sir-factory grade   <wd> [--round N] [--differential 400]   held-out quorum + saturation differential
sir-factory extract <wd>                            carried-data constants + independent-authority assertions
sir-factory pack    <wd> [--scope @rederive]        assemble a verified @rederive/* bundle
sir-factory status  <wd>
```

The full agent sequence (which role runs when, the harden loop, the quarantine policy) is in [`PROTOCOL.md`](PROTOCOL.md); the canonical role prompts are in [`roles/`](roles/).

## Layout

```
factory.mjs        # the CLI entrypoint (Node stdlib only, zero deps)
lib/               # codec · oracle · grade · pack · extract · pkg · trace
roles/             # decomposer.md · reemitter.md  (canonical role prompts)
PROTOCOL.md        # the agent-driven loop
```

## Requirements

Node ≥ 18 (uses `structuredClone`). No runtime dependencies.
