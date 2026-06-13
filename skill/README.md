# abi.ninja Skill

The fourth face (after the REST engine, MCP server, and SDK): a **Claude Skill** that
teaches an agent the contract-interaction workflow (resolve → check provenance →
read or prepare → simulate → hand off) and the non-custodial safety rules.

It's a workflow guide, not code: it makes any Claude that has the `gulltoppr` MCP
tools (or the `gulltoppr`) use them *correctly and safely*, especially the
provenance calibration ("decompiled ⇒ names are inferred") and the never-sign
hand-off model.

## Contents

```
gulltoppr/
  SKILL.md      the workflow + safety rules (loaded into the model's context)
  reference.md  full verb signatures, chain table, error codes, worked example
```

## Install

Copy the skill directory into a skills location:

```bash
# user-level (all projects)
cp -r gulltoppr ~/.claude/skills/gulltoppr

# or project-level
cp -r gulltoppr /path/to/project/.claude/skills/gulltoppr
```

Pairs best with the `gulltoppr` MCP server connected (see [`../README.md`](../README.md)),
so the skill's workflow maps onto live tools. Without the MCP server it still guides
SDK/REST usage.
