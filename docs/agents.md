# Connect your agents

Use one account and key per agent. The server exposes the same data through REST and HTTP MCP; it does not require a particular coding agent or orchestration framework.

## Integration boundaries

The maintained preview integrations are **Claude Code**, **Codex CLI / desktop** and **Cursor CLI**. They have MCP setup recipes, shared workflow instructions and a local file-upload companion. Claude and Codex have session usage readers in `server/scripts/lib/sessions.ts`; Cursor records time itself and leaves unavailable token counts and cost unset. The optional watcher has command presets in `server/scripts/wake.ts`; configure it on an operator's machine before using it. It launches local CLI processes, not the desktop app.

Other tools, including Windsurf (Devin Desktop), Cline, Zoo Code (Roo Code) and Gemini CLI, have **not been validated** for this preview. [Connect other tools](#connect-other-tools) installs the tracker's files for them, but there are no session readers or watcher presets, and nobody has run those clients against the tracker. The protocol is available, but an untested client is not a supported integration. Custom frameworks need an HTTP MCP or REST adapter and their own accounting.

The release checks exercise the MCP protocol through the SDK. They do not certify every version of each agent client. Model choice is separate from client readiness: report the exact model and effort. An unknown model price stays unknown, rather than being recorded as zero cost. Session usage is a list-price estimate when pricing is known, not an extra subscription charge.

The [README readiness table](../README.md#agent-readiness) gives the current status. See [tracking overhead](overhead.md) for the reference workload and its limits.

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

### Cursor CLI

Install and authenticate using the [official CLI guide](https://cursor.com/docs/cli/overview): `agent login`, then `agent status`. `cursor-agent` is also an entry point. Create a separate tracker account named `cursor` (kind `agent`, system `cursor`) and save its key privately in `~/.config/ai-tracker/cursor.key`.

Merge these entries into `~/.cursor/mcp.json`, preserving your other servers:

```json
{
  "mcpServers": {
    "ai-tracker": {
      "url": "https://your-host/mcp",
      "headers": { "Authorization": "Bearer ${env:AI_TRACKER_KEY}" }
    },
    "ai-tracker-files": {
      "command": "node",
      "args": ["/absolute/path/AI-tracker/server/scripts/files-mcp.ts"],
      "env": {
        "AI_TRACKER_URL": "https://your-host",
        "AI_TRACKER_ACCOUNT": "cursor",
        "AI_TRACKER_KEY": ""
      }
    }
  }
}
```

For the HTTP entry, export Cursor's own key as `AI_TRACKER_KEY` before starting the CLI, or store it in the private local config with mode `0600`. Do not inherit another agent's key. The file companion uses `cursor.key` through `AI_TRACKER_ACCOUNT`.

Approve only the required servers with `agent mcp enable ai-tracker` and `agent mcp enable ai-tracker-files`. Verify them using `agent mcp list-tools ai-tracker` and `agent mcp list-tools ai-tracker-files`. Install the tracker skill at `~/.cursor/skills/ai-tracker/SKILL.md`; for interactive project work, put the shared tracker rules in `.cursor/rules/ai-tracker.mdc` with `alwaysApply: true`.

In the watcher's `agents` object, add:

```json
"cursor": {
  "command": ["sh", "/absolute/path/AI-tracker/server/scripts/cursor-wake.sh", "{prompt}"],
  "model": "auto"
}
```

The account stays `cursor` across models. `model` is an optional CLI override; use an identifier from `agent models` to pin a model, or `auto` to let Cursor choose. The wrapper loads Cursor's own tracker key and shared rules, and enables Cursor's sandbox. `--force` allows unattended commands within that sandbox, subject to explicit denies. Project configuration can still impose restrictions.

Cursor's documented stream reports a model display name but does not provide token accounting. With Auto, the tested CLI reported only `Auto`, so the underlying model is unknown: use `model="cursor-auto"`, `effort="unknown"` and explain it in the time entry. Use actual model and effort only when known; leave unknown tokens and cost unset. Do not run the Claude/Codex transcript readers for Cursor. A live Auto check verified tracker identity and reading a task; full autonomous coding and file uploads have not been certified.

### Connect other tools

One command installs the tracker into a project for any of 46 agent tools. The tool ids and folders follow [OpenSpec's table](https://openspec.dev/docs/supported-tools).

```sh
cd server
npm run connect -- --list
npm run connect -- --project /path/to/project --tools gemini,opencode,qwen --human your-account --url https://your-host
```

It does the following for each tool:

- **Skill:** writes `ai-tracker/SKILL.md` to the tool's skills folder. Tools that share `.agents/skills` share one copy.
- **Command:** writes `/tracker-plan` in the tool's format, if the tool has a command folder.
- **MCP:** adds the `ai-tracker` HTTP server, if `--list` shows `automatic`. Other settings in that file stay as they are. An existing `ai-tracker` entry or a file that is not plain JSON is left alone and reported.

Tools marked `by hand` get a printed server address and header to add yourself: the command writes MCP only where the tool's own documentation shows how to read the key from an environment variable. Keys are never written to files. Every tool reads its key from `AI_TRACKER_KEY`, so start each one with its own account's key.

If a tool already has a user-level `ai-tracker` server, including one set up by the recipes above, leave that tool out of `--tools`: two entries with the same name can hide each other. The command prints any step a tool needs before it uses the entry, such as approving a project server or trusting the folder.

Use `--dry-run` to see the changes first. Running the command again refreshes the skill and command files, so keep your own edits elsewhere. Commit the generated files if the whole team uses them. `--tools all` covers every project-level tool; MiniMax Code reads skills only from your home folder, so it has to be named explicitly.

The command also prints how to create each tool's account (`npm run account -- create ...`). Tools without a bundled image appear in the account catalog with a color and letters.

**What this does not give you.** The other tools have no session usage reader, so tokens and cost stay unset unless the agent knows them. They also have no watcher preset. The local `ai-tracker-files` companion and always-on rules files are not installed: agents fall back to `get_upload_command`, and the workflow reaches them through the MCP server's instructions and the skill.

Claude Code, Codex and Cursor keep their own recipes above. `prompts/install.sh` still installs the global rules and all commands for Claude Code and Codex.

## Shared working rules

1. Read the inbox, act on new human comments and acknowledge handled events.
2. Find or create the task in its project. Record human instructions on their behalf.
3. Check dependencies before starting; start a timer on the actual work task.
4. Add progress comments, decisions and useful evidence.
5. Stop the timer with actual model, effort, input/output/cache-read/cache-write token counts and cost when known.
6. Submit the result for human review. Describe what was checked and what remains unverified.
7. The human accepts the result or requests changes.

The reusable instructions are in [prompts/skills/ai-tracker/SKILL.md](../prompts/skills/ai-tracker/SKILL.md). Local file uploads use `server/scripts/files-mcp.ts`; an optional local watcher is described in the [full guide](ru/guide.md#сторож-комментарий-будит-агента).

## Project wiki

Each project has a wiki of Markdown pages. Open **Wiki** from the project page in the web/PWA client. Pages can contain child pages, be moved by choosing a different parent, and link to other pages using their full URL. Deleting a page preserves its children at the deleted page's parent.

Agents use `list_wiki_pages(project_id)` for the tree without content and `get_wiki_page(project_id, page_id)` to read a page. `create_wiki_page`, `update_wiki_page` and `delete_wiki_page` require `model` and `effort`. Set `parent_id` to nest a page or `null` to move it to the root. Updates and deletion require the current `revision`; reread the page and reconcile changes after a conflict. A page cannot be moved to another project or inside its own descendants.

REST exposes the same operations at `/api/projects/{id}/wiki` (GET, POST) and `/api/projects/{id}/wiki/{pageId}` (GET, PATCH, DELETE). PATCH and DELETE take `revision` in their JSON body. Wiki data follows the existing shared-team access model. Native iOS wiki screens are not yet included.

## REST and the contract

Fetch `GET /api/openapi.json` for the current API contract. All data requests require authentication. Agent writes require the exact `model` and `effort`; the server uses these fields for work analytics.

Analytics token sums stay numeric for compatibility. Read `unknown_input_tokens_entries`, `unknown_output_tokens_entries`, `unknown_cache_read_tokens_entries`, and `unknown_cache_write_tokens_entries` alongside them: a count equal to `entries` means usage is unavailable; a smaller positive count means a partial sum. `unknown_tokens_entries` counts records missing input or output. Unknown values must not be presented as confirmed zero.


The existing instance has a single shared team. Projects organise tasks; they are not tenant access boundaries. Give human and agent access only to members trusted with the data in that instance.
