# The cost of tracking work

AI Guild stores tasks, comments, evidence and accounting. The tracker does not call a model to plan, summarise or score work. Additional model usage comes from the agent interacting with the tracker. Database, storage and hosting have their own costs.

## A reproducible reference, not a billing promise

The source-preview MCP server was exercised through the MCP SDK against an isolated PostgreSQL 17 database. A synthetic human assigned one short task to a synthetic agent. The agent then made seven successful calls:

1. `get_inbox`
2. `ack_inbox`
3. `get_task`
4. `start_timer`
5. `add_comment` with one short progress update
6. `stop_timer` with explicitly synthetic, zero model usage
7. `submit_result` with one short result

No LLM generated those calls and no coding work was performed. The zero usage inside the fixture is a synthetic data marker, not the estimated cost of a real agent. This measures actual protocol payloads, not reasoning tokens, client-specific prompts or task execution quality.

The catalogue contains 23 server tools. Optional local file-companion tools and separately installed skills are not included. Responses are counted as text the model reads; compact JSON tool names/arguments are counted as text it generates. Instructions and compact tool definitions are counted separately. JSON-RPC envelopes and provider-specific tool wrappers are excluded.

Two `tiktoken` 0.12.0 encodings provide comparison units; **neither is asserted to be the tokenizer of every Claude or Codex model**. The committed fixture contains only synthetic data and no account keys.

| Context added | `cl100k_base` | `o200k_base` |
| --- | ---: | ---: |
| Shared server instructions | 754 | 756 |
| Full tool catalogue | 6,522 | 6,723 |
| Setup context total | 7,276 | 7,479 |
| Seven call responses, input | 1,062 | 1,060 |
| Seven call names/arguments, output | 248 | 247 |

Raw [fixture](benchmarks/overhead-fixture.json), [counts](benchmarks/overhead-counts.json), [MCP workload](../server/scripts/benchmark-overhead.ts) and [token counter](benchmarks/count-overhead.py) are included. The recorded seven local round trips took 44.8 ms in aggregate on one development machine. This excludes model generation and is not a hosted latency guarantee.

## Convert tokens to an illustrative budget

With hypothetical rates of **$1/M input and $5/M output**, counting each new workflow payload once gives about **$0.0023**. Reading the setup context once adds **$0.0073–0.0075**. These are arithmetic examples, not current provider prices.

Messages can be read again on later turns. A simple full-replay scenario uses seven turns to generate the calls and an eighth to read the final result. Every turn contains the entire setup context and all previous reference call arguments and responses. It yields **62,980–64,595 input tokens and 247–248 output tokens**, or **$0.0642–0.0658** at those hypothetical rates. The counter implements this explicitly; it is not a measured invoice or an upper bound for arbitrary tasks.

Client tool discovery and prompt caching can reduce paid input. Some clients format or repeat server instructions differently. Extra comments, long task histories, polling, image reads, installed skills and reasoning increase usage. No fixed percentage overhead is claimed without a controlled agent run with and without the tracker.

For actual runs, use `server/scripts/session-usage.ts` on Claude Code or Codex session records. It reads reported input, output, cache-read and cache-write usage. That is whole-session usage: it cannot by itself attribute every token to the tracker. Models without a known price remain unpriced. Subscription list-price estimates do not mean an extra API invoice.

## Reproduce

Run from the repository root with a new disposable database. The workload refuses databases whose name does not end in `_demo`, and refuses existing accounts. It never prints or exports the temporary account key. It starts a localhost MCP listener on a random port and closes it after the run.

```sh
docker run --rm -d --name ai-guild-overhead-check \
  -e POSTGRES_USER=aitracker -e POSTGRES_PASSWORD=aitracker \
  -e POSTGRES_DB=overhead_demo -p 127.0.0.1:45545:5432 postgres:17
# Wait until PostgreSQL is ready before the next command.
docker exec ai-guild-overhead-check pg_isready -U aitracker
cd server
npm ci
BENCHMARK_DATABASE_URL=postgres://aitracker:aitracker@127.0.0.1:45545/overhead_demo \
  node scripts/benchmark-overhead.ts /tmp/ai-guild-overhead.json
cd ..
python3 -m venv /tmp/ai-guild-token-count
/tmp/ai-guild-token-count/bin/pip install tiktoken==0.12.0
/tmp/ai-guild-token-count/bin/python docs/benchmarks/count-overhead.py /tmp/ai-guild-overhead.json
docker stop ai-guild-overhead-check
```

Reference server source: `816c638`, Node.js 26.3.0, PostgreSQL 17. Counts can change slightly with timestamp tokenisation and evolve as tools change. Concise comments, bounded inbox reads and binary attachment uploads help keep tracking context small; opening images or reading their contents can still incur model input usage.
