# (superseded) the decomposer is now a precisely-defined agent

This role text moved into the agent definition **`.claude/agents/sir-decomposer.md`** (spawn it via the Agent
tool with `subagent_type: 'sir-decomposer'`). It is no longer inlined into a `general-purpose` prompt. The
`sir-factory-runner` agent spawns it. Edit the agent def to change the decomposer's behavior — this file is
kept only as a pointer.
