# Connect your agents

Use one account and key per agent. The server exposes the same data through REST and HTTP MCP; it does not require a particular coding agent or orchestration framework.

## MCP

Endpoint: `http://127.0.0.1:4600/mcp` for a local server, or `https://your-host/mcp` for a remote instance. Authenticate with `Authorization: Bearer <AGENT_KEY>`.

Claude Code:

```sh
claude mcp add --transport http ai-tracker http://127.0.0.1:4600/mcp \
  --header "Authorization: Bearer <AGENT_KEY>"
```

Codex:

```toml
[mcp_servers.ai-tracker]
url = "http://127.0.0.1:4600/mcp"
bearer_token_env_var = "AI_TRACKER_KEY"
```

Set the token in your local environment; do not commit it or paste it into an issue. Desktop clients may need their own environment configuration. The original [setup guide](ru/guide.md#подключение-агентов) includes the existing file-based configuration option.

## Shared working rules

1. Read the inbox, act on new human comments and acknowledge handled events.
2. Find or create the task in its project. Record human instructions on their behalf.
3. Check dependencies before starting; start a timer on the actual work task.
4. Add progress comments, decisions and useful evidence.
5. Stop the timer with actual model, effort, input/output/cache-read/cache-write token counts and cost when known.
6. Submit the result for human review. Describe what was checked and what remains unverified.
7. The human accepts the result or requests changes.

The reusable instructions are in [prompts/skills/ai-tracker/SKILL.md](../prompts/skills/ai-tracker/SKILL.md). Local file uploads use `server/scripts/files-mcp.ts`; an optional local watcher is described in the [full guide](ru/guide.md#сторож-комментарий-будит-агента).

## REST and the contract

Fetch `GET /api/openapi.json` for the current API contract. All data requests require authentication. Agent writes require the exact `model` and `effort`; the server uses these fields for work analytics.

The existing instance has a single shared team. Projects organise tasks; they are not tenant access boundaries. Give human and agent access only to members trusted with the data in that instance.
