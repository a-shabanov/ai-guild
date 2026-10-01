// Single source of truth for the API contract: REST validation, MCP tool inputs
// and /api/openapi.json are all derived from these schemas.
import { z } from 'zod';

export const STATUSES = ['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
// From the largest piece of work to the smallest; a parent is always above its children.
export const LEVELS = ['epic', 'story', 'task', 'subtask'] as const;
export const KINDS = ['visual', 'technical'] as const;
// As seen from one task: the stored types plus their reverse readings.
export const LINK_TYPES = ['blocks', 'blocked_by', 'relates', 'duplicates', 'duplicated_by'] as const;

const level = z
  .enum(LEVELS)
  .describe('epic: a large goal; story: a result the person can see or use; task: a piece of work; subtask: a step of a task');
const kind = z
  .enum(KINDS)
  .describe('visual: what the person sees (UI, design, graphics, animation); technical: code, data, infrastructure');
export const GROUP_BYS = ['worker', 'model', 'effort', 'account', 'system', 'project', 'day', 'task'] as const;

const model = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe('Exact model id doing the work, e.g. "claude-fable-5-1" or "gpt-5-codex"');
const effort = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(30)
  .describe('Reasoning effort the model runs at, e.g. "low", "medium", "high", "xhigh", "max"');
const accountRef = z
  .union([z.string().trim().min(1), z.number().int()])
  .describe('Account name or numeric id');

// Agents must always say which model/effort they are; enforced in the service layer,
// because humans share the same endpoints and have neither.
export const RunInfo = z.object({
  model: model.optional(),
  effort: effort.optional(),
});

// An agent writing down what a person asked for in chat.
const onBehalf = {
  on_behalf_of: accountRef
    .optional()
    .describe('The person who asked for this in chat. They become the author; you are shown as the one who recorded it'),
  original_text: z
    .string()
    .max(100_000)
    .optional()
    .describe('The person\'s own words, when you reworded them'),
  happened_at: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('When it was actually said or done, if not now (recording history)'),
};

export const CreateAccount = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,39}$/, 'letters, digits, _ . - only; max 40 chars'),
  kind: z.enum(['human', 'agent']),
  system: z.string().trim().max(40).optional().describe('e.g. "claude", "codex"'),
  role: z.enum(['admin', 'member']).default('member'),
});

export const UpdateAccount = z.object({
  disabled: z.boolean().optional(),
  role: z.enum(['admin', 'member']).optional(),
  system: z.string().trim().max(40).nullable().optional(),
});

export const AuthProvider = z.enum(['google', 'telegram']);
export const AuthToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const AuthStart = z.object({
  intent: z.enum(['login', 'link']).default('login'),
  code_challenge: AuthToken.optional(),
  invitation_token: AuthToken.optional(),
});
export const AuthExchange = z.object({
  code: AuthToken,
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
export const InvitationToken = z.object({ token: AuthToken });
export const AccountInvitation = z.object({ url: z.string(), expires_at: z.string().describe('ISO 8601 timestamp') });
export const AuthIdentity = z.object({
  provider: AuthProvider, label: z.string(), created_at: z.string().describe('ISO 8601 timestamp'),
  last_used_at: z.string().nullable().describe('ISO 8601 timestamp'),
});

export const CreateTask = RunInfo.extend({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(100_000).default('').describe('Markdown'),
  status: z.enum(STATUSES).default('todo'),
  priority: z.enum(PRIORITIES).default('normal'),
  project: z.string().trim().min(1).max(100).optional(),
  labels: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  level: level.default('task'),
  kind: kind.optional(),
  parent_id: z.number().int().optional().describe('The task this one is part of; must be of a higher level'),
  assignee: accountRef.optional(),
  ...onBehalf,
});

export const UpdateTask = RunInfo.extend({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(100_000).optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  project: z.string().trim().min(1).max(100).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  level: level.optional(),
  kind: kind.nullable().optional(),
  parent_id: z.number().int().nullable().optional().describe('null moves the task to the top'),
  assignee: accountRef.nullable().optional(),
});

export const LinkTasks = z.object({
  to: z.number().int().describe('Id of the other task'),
  type: z
    .enum(LINK_TYPES)
    .describe('How this task relates to the other: it blocks it, is blocked_by it, relates to it, duplicates it, is duplicated_by it'),
});

export const ListTasks = z.object({
  status: z
    .string()
    .optional()
    .describe('Comma-separated statuses, or "open" for everything not done/cancelled'),
  assignee: z.string().optional().describe('Account name or id, "me", or "none"'),
  project: z.string().optional(),
  level: z.string().optional().describe(`Comma-separated levels: ${LEVELS.join(', ')}`),
  kind: z.string().optional().describe(`${KINDS.join(' or ')}, or "none"`),
  parent: z.string().optional().describe('Id of the parent task, or "none" for top-level tasks'),
  q: z.string().optional().describe('Substring search over title and description'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const AddComment = RunInfo.extend({
  body: z.string().trim().min(1).max(100_000).describe('Markdown. Mention accounts as @name'),
  ...onBehalf,
});

export const SubmitResult = RunInfo.extend({
  result: z.string().trim().min(1).max(200_000).describe('Markdown summary of what was done'),
  status: z.enum(STATUSES).default('review').describe('Status to move the task to'),
  happened_at: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('When the work was actually finished, if not now (recording history)'),
});

const usage = {
  input_tokens: z.number().int().min(0).optional().describe('Uncached input tokens'),
  output_tokens: z.number().int().min(0).optional().describe('Output tokens, thinking included'),
  cache_read_tokens: z.number().int().min(0).optional().describe('Input tokens read from the prompt cache'),
  cache_write_tokens: z.number().int().min(0).optional().describe('Input tokens written to the prompt cache'),
  cost_usd: z.number().min(0).optional().describe('Cost at list API prices'),
  worker: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe('Who exactly did this stretch when several work in parallel, e.g. "main session", "sub-agent: tests"'),
  note: z.string().max(2000).optional(),
};

export const LogTime = RunInfo.extend({
  seconds: z.number().int().min(1).max(7 * 24 * 3600).describe('Duration of the work'),
  started_at: z.iso.datetime({ offset: true }).optional().describe('Defaults to now - seconds'),
  ...usage,
});

export const StartTimer = RunInfo.extend({ note: usage.note, worker: usage.worker });

export const StopTimer = RunInfo.extend({
  time_log_id: z
    .number()
    .int()
    .optional()
    .describe('The entry start_timer returned. Needed when you have several timers running on the task'),
  ...usage,
});

export const UpdateTimeLog = z.object({
  seconds: LogTime.shape.seconds.optional(),
  started_at: LogTime.shape.started_at,
  ...usage,
});

export const ReadInbox = z.object({
  after: z.coerce.number().int().min(0).default(0).describe('Only events with a greater id'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const ReportRun = z.object({
  state: z.enum(['started', 'finished', 'failed']),
  trigger: z.number().int().optional().describe('The event that started the agent'),
  detail: z.string().max(4000).optional().describe('Why it failed: the end of the output'),
});

export const ReadTask = z.object({
  task_id: z.number().int().describe('The task whose events have been read'),
});

export const AckInbox = z.object({
  up_to: z.number().int().min(0).describe('Highest event id that has been handled'),
});

export const Timeline = z.object({
  project: z.string().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  tz: z
    .string()
    .regex(/^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$|^UTC$/)
    .default('UTC')
    .describe('IANA time zone that days are cut in, e.g. Asia/Makassar'),
});

export const Analytics = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  group_by: z
    .string()
    .default('model')
    .describe(`One or two of: ${GROUP_BYS.join(', ')} (comma-separated)`),
  project: z.string().optional(),
});

export const PasskeyResponse = z.object({
  challenge_id: z.string(),
  response: z.looseObject({ id: z.string() }).describe('PublicKeyCredential.toJSON()'),
});

export const PushSubscription = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(200) }),
});

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'hex colour like #2a78d6');

export const CreateProject = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(5000).default('').describe('Markdown'),
  color: color.optional().describe('Accent colour of the project page'),
});

export const UpdateProject = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  color: color.nullable().optional(),
});

export const Project = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string(),
  color: z.string().nullable(),
  logo_url: z.string().nullable(),
  created_by_name: z.string().nullable(),
  created_at: z.string(),
  last_activity_at: z.string().nullable(),
  tasks: z.number(),
  open_tasks: z.number(),
  tasks_by_status: z.record(z.string(), z.number()),
  total_seconds: z.number(),
  cost_usd: z.number(),
  members: z.array(z.object({ name: z.string(), kind: z.enum(['human', 'agent']) })),
  models: z.array(z.string()),
});

export const ApnsDevice = z.object({
  token: z.string().regex(/^[0-9a-fA-F]{32,200}$/, 'hex device token'),
  environment: z.enum(['sandbox', 'production']).default('production'),
});

// ---- Response entities (documentation / client codegen only) ----

const ts = z.string().describe('ISO 8601 timestamp');

export const Account = z.object({
  id: z.number(),
  name: z.string(),
  kind: z.enum(['human', 'agent']),
  system: z.string().nullable(),
  role: z.enum(['admin', 'member']),
  key_prefix: z.string(),
  disabled: z.boolean(),
  created_at: ts,
  last_seen_at: ts.nullable(),
});

export const Task = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string(),
  status: z.enum(STATUSES),
  priority: z.enum(PRIORITIES),
  project: z.string().nullable(),
  labels: z.array(z.string()),
  level: z.enum(LEVELS),
  kind: z.enum(KINDS).nullable(),
  parent_id: z.number().nullable(),
  child_count: z.number(),
  child_done: z.number(),
  created_by: z.number(),
  created_by_name: z.string(),
  recorded_by_name: z.string().nullable().describe('The agent that wrote this down for the author'),
  original_text: z.string().nullable(),
  assignee_id: z.number().nullable(),
  assignee_name: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  result: z.string().nullable(),
  result_by: z.number().nullable(),
  result_by_name: z.string().nullable(),
  result_model: z.string().nullable(),
  result_effort: z.string().nullable(),
  result_at: ts.nullable(),
  created_at: ts,
  updated_at: ts,
  started_at: ts.nullable(),
  completed_at: ts.nullable(),
  total_seconds: z.number(),
  comment_count: z.number(),
  attachment_count: z.number(),
});

export const Comment = z.object({
  id: z.number(),
  task_id: z.number(),
  author_id: z.number(),
  author_name: z.string(),
  author_kind: z.enum(['human', 'agent']),
  recorded_by_name: z.string().nullable(),
  original_text: z.string().nullable(),
  body: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  created_at: ts,
});

export const TimeLog = z.object({
  id: z.number(),
  task_id: z.number(),
  account_id: z.number(),
  account_name: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  seconds: z.number().nullable().describe('null while the timer is running'),
  started_at: ts,
  ended_at: ts.nullable(),
  note: z.string().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  cache_read_tokens: z.number().nullable(),
  cache_write_tokens: z.number().nullable(),
  worker: z.string().nullable(),
  cost_usd: z.number().nullable(),
  created_at: ts,
});

export const Attachment = z.object({
  id: z.number(),
  task_id: z.number(),
  comment_id: z.number().nullable(),
  account_id: z.number(),
  account_name: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number(),
  kind: z.enum(['image', 'video', 'log', 'file']),
  url: z.string().describe('Path to the content, relative to the server root'),
  created_at: ts,
});

export const Event = z.object({
  id: z.number(),
  task_id: z.number(),
  task_title: z.string(),
  project: z.string().nullable(),
  assignee_name: z.string().nullable(),
  actor_id: z.number(),
  actor_name: z.string(),
  actor_kind: z.enum(['human', 'agent']),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  created_at: ts,
});

const TaskRef = z.object({
  id: z.number(),
  title: z.string(),
  status: z.enum(STATUSES),
  level: z.enum(LEVELS),
  kind: z.enum(KINDS).nullable(),
  assignee_name: z.string().nullable(),
});

export const TaskLink = z.object({
  id: z.number(),
  type: z.enum(LINK_TYPES).describe('As seen from the task being read'),
  task: TaskRef,
});

export const TaskDetail = Task.extend({
  ancestors: z.array(TaskRef).describe('From the top of the tree down to the parent'),
  children: z.array(TaskRef),
  links: z.array(TaskLink),
  tree_seconds: z.number().describe('Time logged on this task and everything below it'),
  comments: z.array(Comment),
  time_logs: z.array(TimeLog),
  attachments: z.array(Attachment),
  events: z.array(Event),
});

export const AnalyticsRow = z.object({
  keys: z.array(z.string().nullable()),
  seconds: z.number(),
  entries: z.number(),
  tasks: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  unpriced_entries: z.number(),
  cost_usd: z.number(),
});

export const AnalyticsResult = z.object({
  group_by: z.array(z.string()),
  from: ts.nullable(),
  to: ts.nullable(),
  totals: AnalyticsRow.omit({ keys: true }),
  rows: z.array(AnalyticsRow),
  tasks_by_status: z.record(z.string(), z.number()),
});
