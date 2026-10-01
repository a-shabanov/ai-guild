// MCP server (Streamable HTTP, stateless). A thin wrapper over the service layer:
// every request is authenticated with the caller's API key and gets its own server instance.
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { authenticate, type Actor } from './auth.ts';
import { config } from './config.ts';
import { HttpError } from './errors.ts';
import { keyFromRequest } from './rest.ts';
import * as S from './schemas.ts';
import * as svc from './service.ts';

const INSTRUCTIONS = `AI Tracker: shared task and time tracker for AI agents and their human.

Workflow:
1. At the start of a session call get_inbox. It returns what others (including the human) did on
   your tasks since you last looked: new comments, reassignments, status changes. Act on it, then
   call ack_inbox with the highest event id you handled.
2. Before working, find or create the task (list_tasks / create_task) and call start_timer.
   Work is recorded per stretch: each model, and each sub-agent you delegate to, keeps its own
   entry with its own model, effort and "worker" name, also when they run in parallel.
3. While working, use add_comment for progress, questions and discussion with other agents
   (mention them as @name). Prefer useful visual or analytical artifacts: screenshots,
   recordings, charts, diagrams and reports. Attach files, supplied materials, references and
   logs only when needed to understand or verify the task, or when explicitly requested.
   Do not attach repository source files by default; link to the file, commit or PR instead.
   Use attach_files of the local MCP server "ai-tracker-files", or get_upload_command when it
   is unavailable. Use attach_text for necessary text reports and logs.
4. When finished call stop_timer with your token usage and cost, then submit_result. Report all
   four token counts (input, output, cache read, cache write): with prompt caching most of what
   you read is cache. If you learn the numbers later, fix the entry with update_time_log.

Structure. Work is a tree: epic > story > task > subtask. An epic is a large goal; a story is a
result the person can see or use; a task is a piece of work towards it; a subtask is a step of
a task. Set "level" and "parent_id" when creating. Do not build a tree for small work: one task
is enough for something done in one sitting. Set "kind": visual for what the person sees (UI,
design, graphics, animation), technical for code, data and infrastructure; a task that is both
is split in two. Track time on the lowest level you work at; parents add it up themselves.
Links (link_tasks) say how tasks depend on each other: blocks / blocked_by, relates, duplicates.
Before starting a task, look at its links in get_task: do not start what is blocked by an
unfinished task without saying so.

Images: attach the file, then write ![what it shows](filename.png) in a description, comment or
result to show it inline.
   Results go to "review" by default so the human can check them. If the human comments on the
   result, you will see it in get_inbox - fix what they asked and submit again.

What the person asks for in chat belongs in the tracker too, under their name. When they set a
task, change its scope or give a requirement, record it with on_behalf_of=<their account>:
create_task for a new piece of work, add_comment on the task it refines. Reword it into a clear,
correct statement of what is wanted (do not paste the raw message as the text) and put their own
words in original_text. Attach supplied files and pictures only when needed or explicitly
requested. Do not record questions,
small talk or replies like "ok".

Every write requires "model" (your exact model id) and "effort" (your reasoning effort level).
Report them truthfully; they drive the analytics.`;

type ToolResult = {
  content: (
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  )[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

// Agents must name model and effort, so make them required in the tool schemas.
const run = {
  model: S.RunInfo.shape.model.unwrap(),
  effort: S.RunInfo.shape.effort.unwrap(),
};
const taskId = { task_id: z.number().int().describe('Task id') };

// Compact task shape for lists: full descriptions would flood the context.
function brief(t: Record<string, any>) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    project: t.project,
    assignee: t.assignee_name,
    created_by: t.created_by_name,
    total_seconds: t.total_seconds,
    level: t.level,
    kind: t.kind,
    parent_id: t.parent_id,
    children: t.child_count ? `${t.child_done}/${t.child_count} done` : undefined,
    comments: t.comment_count,
    attachments: t.attachment_count,
    updated_at: t.updated_at,
  };
}

// How a shell command gets the caller's key: the environment, or the key file of the account.
const keyRef = (actor: Actor) => `\${AI_TRACKER_KEY:-$(cat ~/.config/ai-tracker/${actor.name}.key)}`;
const KEY_NOTE =
  'The key comes from AI_TRACKER_KEY or from ~/.config/ai-tracker/<account>.key. If neither ' +
  'exists, ask the person to save the key there; never ask them to paste it into the chat.';

const INBOX_SHOWN = 20;
const INBOX_TEXT = 400;

function buildServer(actor: Actor): McpServer {
  const server = new McpServer(
    { name: 'ai-tracker', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
    readOnly = false,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } },
      (async (args: any) => {
        try {
          return await handler(args);
        } catch (err: any) {
          if (!(err instanceof HttpError)) console.error(err);
          const text = err instanceof HttpError ? err.message : 'internal error';
          return { content: [{ type: 'text', text }], isError: true };
        }
      }) as any,
    );

  tool('whoami', 'The account this API key belongs to.', {}, async () => ok(actor), true);

  tool(
    'list_accounts',
    'All accounts (agents and humans) that tasks can be assigned to or mentioned.',
    {},
    async () =>
      ok(
        (await svc.listAccounts())
          .filter((a) => !a.disabled)
          .map((a) => ({ id: a.id, name: a.name, kind: a.kind, system: a.system })),
      ),
    true,
  );

  tool(
    'list_projects',
    'Projects with their task counts and logged time.',
    {},
    async () => ok(await svc.listProjectDetails()),
    true,
  );

  tool(
    'create_project',
    'Create a project. Tasks can also name a new project directly; it is created on the fly.',
    S.CreateProject.shape,
    async (args) => ok(await svc.createProject(actor, args)),
  );

  tool(
    'update_project',
    'Rename a project or change its description (Markdown) and accent colour.',
    { project_id: z.number().int(), ...S.UpdateProject.shape },
    async ({ project_id, ...args }) => ok(await svc.updateProject(project_id, args)),
  );

  tool(
    'list_tasks',
    'List tasks. Defaults to open tasks. Use assignee="me" for your own.',
    {
      ...S.ListTasks.shape,
      status: S.ListTasks.shape.status.default('open'),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    },
    async (args) => ok((await svc.listTasks(actor, args)).map(brief)),
    true,
  );

  tool(
    'get_task',
    'Full task: description, result, comments, time logs, attachments and history.',
    taskId,
    async ({ task_id }) => {
      const { events, ...task } = await svc.getTask(task_id);
      return ok(task);
    },
    true,
  );

  tool(
    'create_task',
    'Create a task. Assign it to yourself with assignee="me". To write down a task the person ' +
      'gave you in chat, pass on_behalf_of with their account name.',
    { ...S.CreateTask.shape, ...run },
    async (args) => ok(brief(await svc.createTask(actor, args))),
  );

  tool(
    'update_task',
    'Change task fields: status, assignee, title, description, priority, project, labels.',
    { ...taskId, ...S.UpdateTask.shape, ...run },
    async ({ task_id, ...args }) => ok(brief(await svc.updateTask(actor, task_id, args))),
  );

  tool(
    'link_tasks',
    'Link two tasks: one blocks the other, they relate, or one duplicates the other. ' +
      'Parent and child are not links: set parent_id instead.',
    { ...taskId, ...S.LinkTasks.shape },
    async ({ task_id, ...args }) => {
      const task = await svc.linkTasks(actor, task_id, args);
      return ok({ task_id, links: task.links });
    },
  );

  tool(
    'unlink_tasks',
    'Remove a link between tasks; link ids are in get_task.',
    { ...taskId, link_id: z.number().int() },
    async ({ task_id, link_id }) => {
      const task = await svc.unlinkTasks(actor, task_id, link_id);
      return ok({ task_id, links: task.links });
    },
  );

  tool(
    'add_comment',
    'Comment on a task: progress notes, questions, replies to the human or to other agents. ' +
      'With on_behalf_of, writes down what the person said in chat about this task.',
    { ...taskId, ...S.AddComment.shape, ...run },
    async ({ task_id, ...args }) => ok(await svc.addComment(actor, task_id, args)),
  );

  tool(
    'submit_result',
    'Record the outcome of the task and move it to "review" (default) or another status.',
    { ...taskId, ...S.SubmitResult.shape, ...run },
    async ({ task_id, ...args }) => {
      const task = await svc.submitResult(actor, task_id, args);
      const pictures = task.attachments.some((a: any) => a.kind === 'image' || a.kind === 'video');
      return ok({
        ...brief(task),
        ...(task.kind === 'visual' &&
          !pictures && {
            warning:
              'This is a visual task and it has no picture or video attached, so the person cannot ' +
              'see the result. Attach it now with attach_files (MCP server ai-tracker-files) and ' +
              'show it in the result: ![what it shows](file.png).',
          }),
      });
    },
  );

  tool(
    'log_time',
    'Log a finished stretch of work on a task with its token usage and cost. One entry per ' +
      'model and worker: do not merge what different models did into one entry.',
    { ...taskId, ...S.LogTime.shape, ...run },
    async ({ task_id, ...args }) => ok(await svc.logTime(actor, task_id, args)),
  );

  tool(
    'update_time_log',
    'Correct one of your time logs once the real numbers are known: duration, tokens, cost.',
    { time_log_id: z.number().int(), ...S.UpdateTimeLog.shape },
    async ({ time_log_id, ...args }) => ok(await svc.updateTimeLog(actor, time_log_id, args)),
  );

  tool(
    'start_timer',
    'Start timing a stretch of work on a task; returns the entry id. Moves a "todo" task to ' +
      '"in_progress". Every model and every sub-agent working on the task starts its own timer, ' +
      'also in parallel; name yours in "worker".',
    { ...taskId, ...S.StartTimer.shape, ...run },
    async ({ task_id, ...args }) => ok(await svc.startTimer(actor, task_id, args)),
  );

  tool(
    'stop_timer',
    'Stop a running timer of yours and record its time, tokens and cost. With several running ' +
      'on the task, pass the time_log_id that start_timer returned.',
    { ...taskId, ...S.StopTimer.shape },
    async ({ task_id, ...args }) => ok(await svc.stopTimer(actor, task_id, args)),
  );

  tool(
    'attach_text',
    'Attach text content (log, diff, JSON, report) to a task as a file.',
    {
      ...taskId,
      filename: z.string().min(1).max(200).describe('e.g. "build.log"'),
      content: z.string().min(1).max(5_000_000),
      comment_id: z.number().int().optional().describe('Attach to this comment'),
    },
    async ({ task_id, filename, content, comment_id }) =>
      ok(
        await svc.addAttachment(actor, task_id, {
          filename,
          mime: 'text/plain',
          stream: Readable.from(Buffer.from(content, 'utf8')),
          commentId: comment_id,
        }),
      ),
  );

  tool(
    'get_upload_command',
    'How to upload a local file (screenshot, video, archive, large log) to a task. ' +
      'Returns a curl command to run in your shell; binary files cannot go through MCP.',
    { ...taskId, path: z.string().min(1).describe('Local path of the file to upload') },
    async ({ task_id, path }) =>
      ok(
        `curl -sS -X POST -H "Authorization: Bearer ${keyRef(actor)}" ` +
          `-F "file=@${path.replace(/(["\\$`])/g, '\\$1')}" ` +
          `${config.publicUrl}/api/tasks/${task_id}/attachments\n\n` +
          `Repeat -F "file=@..." to upload several files. ${KEY_NOTE}`,
      ),
    true,
  );

  tool(
    'read_attachment',
    'Read an attachment: text files as text (use tail=true for the end of a long log), images as images.',
    {
      attachment_id: z.number().int(),
      tail: z.boolean().default(false).describe('Read the end of the file instead of the start'),
      max_bytes: z.number().int().min(1).max(400_000).default(100_000),
    },
    async ({ attachment_id, tail, max_bytes }) => {
      const { row, path } = await svc.getAttachment(attachment_id);
      const meta = `${row.filename} (${row.mime}, ${row.size} bytes)`;
      if (svc.isTextMime(row.mime)) {
        const { buffer, truncated } = await svc.readAttachmentBytes(path, row.size, {
          maxBytes: max_bytes,
          tail,
        });
        const note = truncated ? ` - showing ${tail ? 'last' : 'first'} ${buffer.length} bytes` : '';
        return ok(`${meta}${note}\n\n${buffer.toString('utf8')}`);
      }
      const viewable = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(row.mime);
      if (viewable && row.size <= 4_000_000) {
        const { buffer } = await svc.readAttachmentBytes(path, row.size, { maxBytes: row.size });
        return {
          content: [
            { type: 'text', text: meta },
            { type: 'image', data: buffer.toString('base64'), mimeType: row.mime },
          ],
        };
      }
      return ok(
        `${meta} cannot be shown inline. Download it with:\n` +
          `curl -sS -H "Authorization: Bearer ${keyRef(actor)}" -o "${row.filename}" ${config.publicUrl}${row.url}\n\n${KEY_NOTE}`,
      );
    },
    true,
  );

  tool(
    'get_inbox',
    'What others did on tasks you are involved in (or where you are @mentioned) since your last ' +
      'ack_inbox: comments from the human and other agents, assignments, status changes.',
    {},
    async () => {
      const { events } = await svc.getInbox(actor);
      if (!events.length) return ok('Inbox is empty.');
      // Everything returned here is re-read on every later step of the session, so the inbox
      // gives the gist; the full text is one get_task away.
      const shown = events.slice(-INBOX_SHOWN);
      const clip = (text: unknown, taskId: number) =>
        typeof text === 'string' && text.length > INBOX_TEXT
          ? `${text.slice(0, INBOX_TEXT)}… [${text.length - INBOX_TEXT} more characters, see get_task ${taskId}]`
          : text;
      return ok({
        ...(events.length > shown.length && {
          earlier: `${events.length - shown.length} older events are not shown; they are acknowledged together with these`,
        }),
        events: shown.map((e) => ({
          event_id: e.id,
          task_id: e.task_id,
          task_title: e.task_title,
          type: e.type,
          by: `${e.actor_name} (${e.actor_kind})`,
          at: e.created_at,
          ...Object.fromEntries(
            Object.entries(e.data)
              .filter(([k, v]) => v !== null && !['comment_id', 'history'].includes(k))
              .map(([k, v]) => [k, clip(v, e.task_id)]),
          ),
        })),
        next: `After handling these, call ack_inbox with up_to=${events.at(-1)!.id}`,
      });
    },
    true,
  );

  tool(
    'ack_inbox',
    'Mark inbox events up to the given event id as handled.',
    S.AckInbox.shape,
    async ({ up_to }) => ok(await svc.ackInbox(actor, up_to)),
  );

  tool(
    'get_analytics',
    'Aggregated time, tokens and cost, grouped by one or two dimensions.',
    S.Analytics.shape,
    async (args) => ok(await svc.analytics(args)),
    true,
  );

  return server;
}

export async function handleMcp(req: Request, res: Response): Promise<void> {
  let actor: Actor;
  try {
    actor = await authenticate(keyFromRequest(req));
  } catch (err: any) {
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer')
      .json({ jsonrpc: '2.0', error: { code: -32001, message: err.message }, id: null });
    return;
  }
  if (req.method !== 'POST') {
    // Stateless server: no standalone SSE stream and no sessions to delete.
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'method not allowed' }, id: null });
    return;
  }
  const server = buildServer(actor);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
