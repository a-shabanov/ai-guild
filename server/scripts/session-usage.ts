// What a Claude Code or Codex session cost and what the person asked for in it, read from
// the session's own record on disk. Used to log work in the tracker with real numbers.
//
//   node session-usage.ts <file>                        usage of the whole session
//   node session-usage.ts <file> --from ISO --to ISO     usage of one stretch
//   node session-usage.ts <file> --segments              usage split at every prompt and chapter
//   node session-usage.ts <file> --prompts [--out DIR]   what the person wrote; pictures they
//                                                        sent are saved into DIR
//   node session-usage.ts --find claude|codex [--cwd DIR] [--all]
//                                                        the session file(s) for a directory,
//                                                        most recent first
//
// <file> is a Claude Code transcript (~/.claude/projects/<dir>/<session>.jsonl) or a Codex
// rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl); the format is detected.
//
// Token counts are what the API reported, not estimates. Cost is at list API prices; on a
// subscription it is a yardstick, not a charge. Models without a known price get no cost.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { find, read, summarize } from './lib/sessions.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    segments: { type: 'boolean' },
    prompts: { type: 'boolean' },
    out: { type: 'string' },
    find: { type: 'string' },
    cwd: { type: 'string' },
    all: { type: 'boolean' },
  },
});

if (values.find) {
  if (values.find !== 'claude' && values.find !== 'codex') throw new Error('--find takes claude or codex');
  const found = find(values.find, resolve(values.cwd ?? process.cwd()), values.all ?? false);
  if (!found.length) {
    console.error(`no ${values.find} sessions found for ${resolve(values.cwd ?? process.cwd())}`);
    process.exit(1);
  }
  console.log(found.join('\n'));
} else {
  main(positionals[0]);
}

function main(path: string | undefined): void {
if (!path) {
  console.error('usage: node session-usage.ts <session.jsonl> [--segments | --prompts [--out DIR]] [--from ISO] [--to ISO]\n       node session-usage.ts --find claude|codex [--cwd DIR] [--all]');
  process.exit(1);
}

const session = read(path);
const from = values.from ? Date.parse(values.from) : Math.min(session.messages[0]?.at ?? Infinity, session.marks[0]?.at ?? Infinity);
const to = values.to ? Date.parse(values.to) : Infinity;

if (values.prompts) {
  if (values.out) mkdirSync(values.out, { recursive: true });
  const prompts = session.prompts
    .filter((p) => Date.parse(p.at) >= from && Date.parse(p.at) < to)
    .map((p, i) => ({
      at: p.at,
      text: p.text,
      images: p.images.map((image, k) => {
        if (!values.out) return `(${image.mime}; pass --out DIR to save it)`;
        const ext = (image.mime.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
        const file = join(values.out, `prompt-${String(i + 1).padStart(2, '0')}-${k + 1}.${ext}`);
        writeFileSync(file, Buffer.from(image.data, 'base64'));
        return file;
      }),
    }));
  console.log(JSON.stringify({ agent: session.agent, cwd: session.cwd, prompts }, null, 2));
} else if (values.segments) {
  const inside = session.marks.filter((m) => m.at >= from && m.at < to);
  console.log(
    JSON.stringify(
      inside.map((mark, i) => summarize(session.messages, mark.at, inside[i + 1]?.at ?? to, mark.label)),
      null,
      2,
    ),
  );
} else {
  console.log(JSON.stringify({ agent: session.agent, cwd: session.cwd, ...summarize(session.messages, from, to) }, null, 2));
}
}
