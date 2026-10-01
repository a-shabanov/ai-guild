"""Count reference context, not provider billing. Requires tiktoken==0.12.0."""
import json
import sys
import tiktoken

with open(sys.argv[1], encoding="utf-8") as source:
    fixture = json.load(source)

def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

output = {"tool_count": len(fixture["tools"]), "call_count": len(fixture["calls"]), "encodings": {}}
for name in ("cl100k_base", "o200k_base"):
    encoding = tiktoken.get_encoding(name)
    def count(value):
        return len(encoding.encode(value))
    calls = [{
        "name": call["name"],
        "input": sum(count(part["text"]) for part in call["result"]["content"] if part["type"] == "text"),
        "output": count(compact({"name": call["name"], "arguments": call["arguments"]})),
    } for call in fixture["calls"]]
    instructions = count(fixture["instructions"])
    catalog = count(compact(fixture["tools"]))
    # Seven call-generation turns followed by one turn that reads the final result.
    replay = instructions + catalog
    context = 0
    for call in calls:
        context += call["input"] + call["output"]
        replay += instructions + catalog + context
    output["encodings"][name] = {
        "instructions": instructions, "catalog": catalog, "setup_input": instructions + catalog,
        "workflow_input": sum(call["input"] for call in calls),
        "workflow_output": sum(call["output"] for call in calls), "calls": calls,
        "full_replay_input": replay,
        "full_replay_example_usd": (replay + 5 * sum(call["output"] for call in calls)) / 1_000_000,
    }
output["local_roundtrip_ms"] = round(sum(call["milliseconds"] for call in fixture["calls"]), 1)
print(json.dumps(output, indent=2))
