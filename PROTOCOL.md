# Agent-driven run protocol

The factory runs **as an agent**, in-session, with **no API key**. The orchestrating agent (the main Claude
Code loop, or a dedicated long-running runner agent for the unattended loop) drives the sequence below,
calling the mechanical CLI via Bash and spawning the two roles via the **Agent tool**.

The roles are exactly the two the slugify pilot validated, and the validity guarantee is structural:
- **Sighted decomposer** = a `general-purpose` (or `Explore`) subagent with Read access. It alone reads the
  original.
- **Blind re-emitters** = the `sir-reemitter` subagent type, which is **Write-only** — it physically cannot
  Read, so "original-deleted" is enforced by the tool layer, not by instruction.

## Per package

1. **install** (Bash):
   `sir-factory install <name> <ver> --out <root> --unit <unit> [--export <e>] [--hint "<h>"]`
   → prints `workdir`, `pkgDir`, and the two paths the decomposer must write.

2. **decompose** (Agent tool → `general-purpose`, system prompt = `roles/decomposer.md`):
   Task it to read `pkgDir` and write `<workdir>/sir/<unit>.sir` + `<workdir>/sir/<unit>.inputs.mjs`.
   It self-declares `ORACLE-CLASS`; if non-deterministic (clock/RNG/io), the next step quarantines.

3. **stamp** (Bash): `sir-factory stamp <workdir> [--frozen 16 --heldout 13]`
   → stamps the oracle from the **real** package, leakage-guarded; prints the SIR path + the FROZEN ORACLE
   block to inline into the re-emitter prompts. (Quarantines here on non-determinism / leakage / no-SIR.)

4. **re-emit** (Agent tool → `sir-reemitter` ×N, in parallel): give each the SIR (read the SIR_PATH) + the
   printed FROZEN ORACLE inline, and a distinct output path `<workdir>/runs/emit_<i>.mjs`. They cannot read
   the source.
   - **Inline the SIR file content VERBATIM — never paraphrase or condense it.** Hand-condensing the SIR into
     a prompt introduced two transcription bugs (a wrong constant, a dropped `$` separator). Paste the file's
     bytes; if it's long, that's fine.
   - **Carried data:** if the decomposer declared carried constants (`sir/<unit>.carried.json`), run
     `sir-factory extract <workdir>` first — it byte-exact-extracts them to `src/<unit>.data.js` (+ a
     `runs/` copy), runs the independent-authority check, and applies the (a)/(b) gate. Tell the re-emitter to
     `import` the named constants from `./<unit>.data.js` and reconstruct only the LOGIC — never transcribe the
     table.
   - **Large SIRs (inline gets unwieldy / risks transcription error — e.g. bcrypt's 28 KB SIR):** run
     `sir-factory stage-reemit <workdir>` to write a CLEAN ROOM (`<workdir>/reemit/`: the SIR + a rendered
     `frozen.md`, and nothing else — no source, no meta), then spawn **`sir-reemitter-cr`** agents
     (`subagent_type: 'sir-reemitter-cr'`) that **READ those files from disk** (Read+Write only, no
     Bash/search/net, source absent → still blind) and write `runs/emit_<i>.mjs`. This removes the hand-inline
     entirely. NOTE: agent types load at session start — a newly added agent needs a session restart to appear
     in the Agent tool.

## Two re-emit paths

- **Small/medium SIR → inline** (`sir-reemitter`, Write-only): the driver pastes the SIR + frozen oracle
  verbatim into the prompt. Truly blind (no Read tool). Used for slugify/uuid.
- **Large SIR → clean-room file-read** (`sir-reemitter-cr`, Read+Write): the driver stages a contract-only dir
  and the agent reads the SIR from disk. Blind via Read-without-search + absent source. Used for bcrypt-class
  units whose SIR is too large to hand-inline reliably.

5. **grade** (Bash): `sir-factory grade <workdir> --round <r> [--cap 3] [--differential 400]`
   → GATE 1 held-out quorum (≥2) + GATE 2 saturation differential vs real (only if quorum).
   - `verified` → promotes `src/<unit>.js` (exit 0).
   - failure → writes `divergence.json` and routes to **hardening** (exit 2) — unless round ≥ cap, then
     `quarantine` (exit 1). Updates `state.json`.

## The hardening loop (the key discipline)

**A quorum or differential failure means the SIR is inadequate** — if independent blind engineers diverge from
a definition, the definition is ambiguous or incomplete. So the orchestrating agent does NOT re-roll the
emitters; it **kicks the SIR back to the decomposer to harden the definition**:

```
round r grade fails (exit 2) → re-spawn the decomposer in HARDEN mode (Agent tool), giving it the prior
  <workdir>/sir/<unit>.sir + <workdir>/divergence.json → it rewrites a hardened SIR (+ generator if the gap
  was coverage) → re-stamp → re-emit N blind → grade --round r+1
```

Repeat until `verified` or `--cap` rounds (default 3), then `quarantine` for human review. A good SIR makes
independent re-emitters converge *consistently* (never 100% — they're non-deterministic); kicking the SIR back
is how the **definition itself** gets hardened, which is the product. The decomposer can re-read the original
to resolve each divergence, so hardening is grounded in the source, not guesswork.

**Harden vs decompose.** Hardening resolves *ambiguity*. But if a unit keeps diverging because it is
*compound* (a glob matcher, a parser, an expression evaluator), the fix is NOT more SIR detail — a SIR that
dictates the exact output (the regex to emit, the parse table) buys convergence by **transcription**, which
hollows out the independence the quorum measures. Such a unit is UNDER-DECOMPOSED: split it into named leaves
(each with a tight behavioral oracle) and run each through the factory. Divergence on a compound unit is a
decomposition signal, not a spec-detail gap.

`sir-factory status --out <root>` summarizes progress; the loop is resumable (skip verified/quarantined)
and the agent tracks token cost from the Agent-tool results.

## Unattended (the 2-day loop)

The runner is a Claude Code **agent session** (e.g. via `/loop` or a cron that re-invokes Claude Code), which
walks the worklist running this protocol. No `claude -p`, no separate key — the subagents are spawned in-session
via the Agent tool and billed to the subscription.
