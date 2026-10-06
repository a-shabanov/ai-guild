import { EventEmitter } from 'node:events';
// Business logic shared by the REST API and the MCP server.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import type { z } from 'zod';
import { q, q1, pool, type Row } from './db.ts';
import { config } from './config.ts';
import { HttpError } from './errors.ts';
import { generateKey, hashKey, requireAdmin, type Actor } from './auth.ts';
import { notifyEvent } from './push.ts';
import * as S from './schemas.ts';
import { validatePreset, removeAvatar } from './account-avatars.ts';

const attachmentsDir = join(config.dataDir, 'attachments');

// ---------- helpers ----------

function requireRunInfo(actor: Actor, info: { model?: string; effort?: string }): void {
  if (actor.kind === 'agent' && (!info.model || !info.effort)) {
    throw new HttpError(400, 'agent accounts must provide both "model" and "effort"');
  }
}

async function resolveAccount(ref: string | number, actor?: Actor): Promise<Row> {
  if (ref === 'me' && actor) return { id: actor.id, name: actor.name };
  const byId = typeof ref === 'number' || /^\d+$/.test(ref);
  const row = await q1(
    `select id, name, disabled from accounts where deleted_at is null and ${byId ? 'id = $1' : 'lower(name) = lower($1)'}`,
    [ref],
  );
  if (!row) throw new HttpError(404, `account "${ref}" not found`);
  return row;
}

/** Tells the open streams that something has happened; see GET /api/events/stream. */
export const news = new EventEmitter();
news.setMaxListeners(0);

async function addEvent(taskId: number, actor: Actor, type: string, data: Row = {}): Promise<void> {
  // History is written to the task's log, but it is not news: no inbox entry, no push.
  const history = actor.history === true || data.history === true;
  const row = await q1(
    'insert into events(task_id, actor_id, type, data) values ($1, $2, $3, $4) returning id',
    [taskId, actor.id, type, JSON.stringify(history ? { ...data, history: true } : data)],
  );
  if (!history) {
    news.emit('event', row!.id);
    notifyEvent(row!.id).catch((err) => console.error('push failed', err));
  }
}

const TASK_SELECT = `
  select t.*,
         cb.name as created_by_name,
         a.name  as assignee_name,
         rb.name as result_by_name,
         rec.name as recorded_by_name,
         coalesce((select sum(seconds) from time_logs l where l.task_id = t.id), 0) as total_seconds,
         (select count(*) from tasks k where k.parent_id = t.id) as child_count,
         (select count(*) from tasks k where k.parent_id = t.id and k.status = 'done') as child_done,
         (select count(*) from comments c where c.task_id = t.id) as comment_count,
         (select count(*) from attachments x where x.task_id = t.id) as attachment_count
    from tasks t
    join accounts cb on cb.id = t.created_by
    left join accounts a on a.id = t.assignee_id
    left join accounts rb on rb.id = t.result_by
    left join accounts rec on rec.id = t.recorded_by`;

const ACCOUNT_COLS =
  `id, name, kind, system, role, key_prefix, disabled, created_at, last_seen_at, avatar_preset,
   case when avatar_key is not null then '/api/accounts/' || id || '/avatar?v=' || avatar_key else null end as avatar_url`;

function attachmentRow(row: Row): Row {
  const { storage_key, ...rest } = row;
  return { ...rest, url: `/api/attachments/${row.id}/content` };
}

// Resolves who the entry belongs to. An agent may write down what a person asked for; it may
// not speak for another agent, and the record always shows who did the writing.
async function authorship(
  actor: Actor,
  input: { on_behalf_of?: string | number; happened_at?: string },
): Promise<{ author: Actor; recorder: Actor | null; at: string | null }> {
  if (input.happened_at && Date.parse(input.happened_at) > Date.now() + 60_000) {
    throw new HttpError(400, 'happened_at is in the future');
  }
  const at = input.happened_at ?? null;
  if (input.on_behalf_of === undefined) return { author: actor, recorder: null, at };
  const found = await resolveAccount(input.on_behalf_of, actor);
  const person = await q1('select id, name, kind, system, role, disabled from accounts where id = $1', [found.id]);
  if (person!.kind !== 'human') throw new HttpError(400, 'on_behalf_of must be a person, not an agent');
  if (person!.disabled) throw new HttpError(400, `account "${person!.name}" is disabled`);
  if (person!.id === actor.id) return { author: actor, recorder: null, at };
  return { author: { ...(person as Actor), history: actor.history }, recorder: actor, at };
}

const TASK_REF = `t.id, t.title, t.status, t.level, t.kind, a.name as assignee_name
                    from tasks t left join accounts a on a.id = t.assignee_id`;
const REVERSE: Record<string, string> = { blocks: 'blocked_by', duplicates: 'duplicated_by', relates: 'relates' };
const rank = (level: string) => (S.LEVELS as readonly string[]).indexOf(level);

// The tree stays well-formed: a parent is of a higher level than the task, and the task is
// of a higher level than everything under it.
async function assertPlace(level: string, parentId: number | null, taskId?: number): Promise<void> {
  if (parentId !== null) {
    if (parentId === taskId) throw new HttpError(400, 'a task cannot be its own parent');
    const parent = await q1('select id, level from tasks where id = $1', [parentId]);
    if (!parent) throw new HttpError(404, `parent task ${parentId} not found`);
    if (rank(parent.level) >= rank(level)) {
      throw new HttpError(
        400,
        `a ${level} cannot be part of a ${parent.level} (#${parentId}); the order is ${S.LEVELS.join(' > ')}`,
      );
    }
  }
  if (taskId !== undefined) {
    const child = await q1(
      `select id, level from tasks where parent_id = $1
        order by array_position($2::text[], level) limit 1`,
      [taskId, S.LEVELS],
    );
    if (child && rank(child.level) <= rank(level)) {
      throw new HttpError(400, `it has a ${child.level} under it (#${child.id}), so it cannot become a ${level}`);
    }
  }
}

async function assertTask(id: number): Promise<Row> {
  const row = await q1('select id, status, started_at from tasks where id = $1', [id]);
  if (!row) throw new HttpError(404, `task ${id} not found`);
  return row;
}

// ---------- accounts ----------

export async function createAccount(
  input: z.infer<typeof S.CreateAccount>,
  actor?: Actor,
): Promise<{ account: Row; key: string }> {
  if (actor) requireAdmin(actor);
  await validatePreset(input.avatar_preset);
  if (input.kind !== 'agent' && input.avatar_preset != null) throw new HttpError(400, 'avatar selection is for agents');
  const key = generateKey();
  try {
    const account = await q1(
      `insert into accounts(name, kind, system, role, key_hash, key_prefix, avatar_preset)
       values ($1, $2, $3, $4, $5, $6, $7) returning ${ACCOUNT_COLS}`,
      [input.name, input.kind, input.system ?? null, input.role, hashKey(key), key.slice(0, 8), input.avatar_preset ?? null],
    );
    return { account: account!, key };
  } catch (err: any) {
    if (err.code === '23505') throw new HttpError(409, `account "${input.name}" already exists`);
    throw err;
  }
}

export async function listAccounts(): Promise<Row[]> {
  return q(`select ${ACCOUNT_COLS} from accounts where deleted_at is null order by kind, name`);
}

export async function updateAccount(
  actor: Actor,
  id: number,
  input: z.infer<typeof S.UpdateAccount>,
): Promise<Row> {
  requireAdmin(actor);
  await validatePreset(input.avatar_preset);
  if (id === actor.id && (input.disabled || input.role === 'member')) {
    throw new HttpError(400, 'you cannot disable or demote your own account');
  }
  const client = await pool.connect();
  let previousAvatar: string | null = null;
  let row: Row;
  try {
    await client.query('begin');
    const account = (await client.query('select kind, avatar_key from accounts where id=$1 and deleted_at is null for update', [id])).rows[0];
    if (!account) throw new HttpError(404, `account ${id} not found`);
    if (input.avatar_preset !== undefined && account.kind !== 'agent') throw new HttpError(400, 'avatar selection is for agents');
    if (input.avatar_preset !== undefined) previousAvatar = account.avatar_key;
    row = (await client.query(
      `update accounts set
         name = coalesce($2, name),
         disabled = coalesce($3, disabled),
         role = coalesce($4, role),
         system = case when $5::boolean then $6 else system end,
         avatar_preset = case when $7::boolean then $8 else avatar_preset end,
         avatar_key = case when $7::boolean then null else avatar_key end,
         avatar_mime = case when $7::boolean then null else avatar_mime end
       where id = $1 returning ${ACCOUNT_COLS}`,
      [id, input.name ?? null, input.disabled ?? null, input.role ?? null, input.system !== undefined,
        input.system ?? null, input.avatar_preset !== undefined, input.avatar_preset ?? null],
    )).rows[0];
    await client.query('commit');
  } catch (err: any) {
    await client.query('rollback');
    if (err.code === '23505') throw new HttpError(409, `account "${input.name}" already exists`);
    throw err;
  } finally {
    client.release();
  }
  await removeAvatar(previousAvatar);
  return row;
}

export async function deleteAccount(actor: Actor, id: number): Promise<void> {
  requireAdmin(actor);
  if (id === actor.id) throw new HttpError(400, 'you cannot delete your own account');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const account = (await client.query('select id from accounts where id=$1 and deleted_at is null for update', [id])).rows[0];
    if (!account) throw new HttpError(404, `account ${id} not found`);
    await client.query('update accounts set deleted_at=now(), disabled=true, key_hash=$2 where id=$1', [id, hashKey(generateKey())]);
    // Credentials and notifications are disposable; authored work keeps its account reference.
    for (const table of ['sessions', 'auth_flows', 'auth_exchanges', 'account_invitations',
      'two_factor_codes', 'two_factor_logins', 'account_second_factors', 'passkeys',
      'account_identities', 'push_subscriptions', 'apns_devices', 'account_devices']) {
      await client.query(`delete from ${table} where account_id=$1`, [id]);
    }
    await client.query(`update time_logs set ended_at=now(),
      seconds=greatest(1, floor(extract(epoch from (now()-started_at))))
      where account_id=$1 and ended_at is null`, [id]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function rotateKey(actor: Actor, id: number): Promise<{ account: Row; key: string }> {
  if (id !== actor.id) requireAdmin(actor);
  const key = generateKey();
  const account = await q1(
    `update accounts set key_hash = $2, key_prefix = $3 where id = $1 and deleted_at is null returning ${ACCOUNT_COLS}`,
    [id, hashKey(key), key.slice(0, 8)],
  );
  if (!account) throw new HttpError(404, `account ${id} not found`);
  // A rotated key usually means the old one leaked; drop everything that was signed in with it.
  await q(`delete from sessions where account_id = $1 and method = 'key'`, [id]);
  return { account, key };
}

// ---------- tasks ----------

export async function listTasks(actor: Actor, input: z.infer<typeof S.ListTasks>): Promise<Row[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;

  if (input.status === 'open') {
    where.push(`t.status not in ('done', 'cancelled')`);
  } else if (input.status) {
    const statuses = input.status.split(',').map((s) => s.trim());
    for (const s of statuses) {
      if (!(S.STATUSES as readonly string[]).includes(s)) {
        throw new HttpError(400, `unknown status "${s}"`);
      }
    }
    where.push(`t.status = any(${p(statuses)})`);
  }
  if (input.assignee === 'none') {
    where.push('t.assignee_id is null');
  } else if (input.assignee) {
    where.push(`t.assignee_id = ${p((await resolveAccount(input.assignee, actor)).id)}`);
  }
  if (input.project) where.push(`lower(t.project) = lower(${p(input.project)})`);
  if (input.level) {
    const levels = input.level.split(',').map((s) => s.trim());
    for (const l of levels) if (rank(l) < 0) throw new HttpError(400, `unknown level "${l}"`);
    where.push(`t.level = any(${p(levels)})`);
  }
  if (input.kind === 'none') where.push('t.kind is null');
  else if (input.kind) {
    if (!(S.KINDS as readonly string[]).includes(input.kind)) throw new HttpError(400, `unknown kind "${input.kind}"`);
    where.push(`t.kind = ${p(input.kind)}`);
  }
  if (input.parent === 'none') where.push('t.parent_id is null');
  else if (input.parent) {
    if (!/^\d+$/.test(input.parent)) throw new HttpError(400, 'parent is a task id or "none"');
    where.push(`t.parent_id = ${p(Number(input.parent))}`);
  }
  if (input.q) {
    const like = p(`%${input.q.replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(t.title ilike ${like} or t.description ilike ${like})`);
  }

  return q(
    `${TASK_SELECT}
     ${where.length ? 'where ' + where.join(' and ') : ''}
     order by array_position(array['urgent','high','normal','low'], t.priority), t.updated_at desc
     limit ${p(input.limit)} offset ${p(input.offset)}`,
    params,
  );
}

export async function getTask(id: number): Promise<Row> {
  const task = await q1(`${TASK_SELECT} where t.id = $1`, [id]);
  if (!task) throw new HttpError(404, `task ${id} not found`);
  const [ancestors, children, links, tree] = await Promise.all([
    q(
      `with recursive up as (
         select p.id, p.parent_id, 1 as depth from tasks p where p.id = $1
         union all
         select p.id, p.parent_id, up.depth + 1 from tasks p join up on p.id = up.parent_id
       )
       select ${TASK_REF} join up on up.id = t.id order by up.depth desc`,
      [task.parent_id],
    ),
    q(
      `select ${TASK_REF} where t.parent_id = $1
        order by array_position(array['in_progress','review','blocked','todo','done','cancelled'], t.status), t.id`,
      [id],
    ),
    q(
      `select l.id as link_id, l.type, l.from_task, ${TASK_REF}
         join task_links l on t.id = case when l.from_task = $1 then l.to_task else l.from_task end
        where l.from_task = $1 or l.to_task = $1
        order by l.id`,
      [id],
    ),
    q1(
      `with recursive down as (
         select id from tasks where id = $1
         union all
         select k.id from tasks k join down on k.parent_id = down.id
       )
       select coalesce(sum(l.seconds), 0) as seconds from time_logs l join down on down.id = l.task_id`,
      [id],
    ),
  ]);
  task.ancestors = ancestors;
  task.children = children;
  task.links = links.map(({ link_id, type, from_task, ...other }) => ({
    id: link_id,
    type: from_task === id ? type : REVERSE[type],
    task: other,
  }));
  task.tree_seconds = tree!.seconds;
  const [comments, time_logs, attachments, events] = await Promise.all([
    q(
      `select c.*, a.name as author_name, a.kind as author_kind, rec.name as recorded_by_name
         from comments c
         join accounts a on a.id = c.author_id
         left join accounts rec on rec.id = c.recorded_by
        where c.task_id = $1 order by c.created_at, c.id`,
      [id],
    ),
    q(
      `select l.*, a.name as account_name
         from time_logs l join accounts a on a.id = l.account_id
        where l.task_id = $1 order by l.started_at, l.id`,
      [id],
    ),
    q(
      `select x.*, a.name as account_name
         from attachments x join accounts a on a.id = x.account_id
        where x.task_id = $1 order by x.id`,
      [id],
    ),
    q(`${EVENT_SELECT} where e.task_id = $1 order by e.id`, [id]),
  ]);
  return { ...task, comments, time_logs, attachments: attachments.map(attachmentRow), events };
}

export async function createTask(actor: Actor, input: z.infer<typeof S.CreateTask>): Promise<Row> {
  const { author, recorder, at } = await authorship(actor, input);
  // Model and effort describe the run that did the work; a person's request has neither.
  const run: { model?: string; effort?: string } = recorder ? {} : input;
  requireRunInfo(author, run);
  const assignee = input.assignee !== undefined ? await resolveAccount(input.assignee, actor) : null;
  await assertPlace(input.level, input.parent_id ?? null);
  // Part of something: it belongs to the same project unless told otherwise.
  const parentProject =
    input.parent_id !== undefined && input.project === undefined
      ? (await q1('select project from tasks where id = $1', [input.parent_id]))!.project
      : null;
  const row = await q1(
    `insert into tasks(title, description, status, priority, project, labels, parent_id,
                       created_by, assignee_id, model, effort, started_at, completed_at,
                       recorded_by, original_text, created_at, updated_at, level, kind)
     values ($1, $2, $3::text, $4, $5, $6, $7, $8, $9, $10, $11,
             case when $3::text = 'in_progress' then coalesce($14::timestamptz, now()) end,
             case when $3::text = 'done' then now() end,
             $12, $13, coalesce($14::timestamptz, now()), now(), $15, $16)
     returning id`,
    [
      input.title,
      input.description,
      input.status,
      input.priority,
      (await resolveProject(actor, input.project)) ?? parentProject,
      input.labels,
      input.parent_id ?? null,
      author.id,
      assignee?.id ?? null,
      run.model ?? null,
      run.effort ?? null,
      recorder?.id ?? null,
      input.original_text ?? null,
      at,
      input.level,
      input.kind ?? null,
    ],
  );
  await addEvent(row!.id, author, 'task_created', {
    title: input.title,
    assignee: assignee?.name ?? null,
    model: run.model ?? null,
    effort: run.effort ?? null,
    ...(recorder && { recorded_by: recorder.name }),
  });
  return getTask(row!.id);
}

export async function updateTask(
  actor: Actor,
  id: number,
  input: z.infer<typeof S.UpdateTask>,
): Promise<Row> {
  const before = await q1('select * from tasks where id = $1', [id]);
  if (!before) throw new HttpError(404, `task ${id} not found`);

  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, v: unknown) => sets.push(`${col} = $${params.push(v)}`);
  const run = { model: input.model ?? null, effort: input.effort ?? null };

  for (const col of ['title', 'description', 'priority', 'labels', 'kind'] as const) {
    if (input[col] !== undefined) set(col, input[col]);
  }
  if (input.level !== undefined || input.parent_id !== undefined) {
    const parentId = input.parent_id !== undefined ? input.parent_id : before.parent_id;
    await assertPlace(input.level ?? before.level, parentId, id);
    if (input.level !== undefined) set('level', input.level);
    if (input.parent_id !== undefined) set('parent_id', input.parent_id);
  }
  if (input.project !== undefined) set('project', await resolveProject(actor, input.project));

  let assignee: Row | null | undefined;
  if (input.assignee !== undefined) {
    assignee = input.assignee === null ? null : await resolveAccount(input.assignee, actor);
    set('assignee_id', assignee?.id ?? null);
  }

  const statusChanged = input.status !== undefined && input.status !== before.status;
  if (statusChanged) {
    requireRunInfo(actor, input);
    set('status', input.status);
    if (input.status === 'in_progress' && !before.started_at) sets.push('started_at = now()');
    sets.push(`completed_at = ${input.status === 'done' ? 'now()' : 'null'}`);
  }

  if (!sets.length) return getTask(id);
  sets.push('updated_at = now()');
  await q(`update tasks set ${sets.join(', ')} where id = $1`, params);

  if (statusChanged) {
    await addEvent(id, actor, 'status_changed', { from: before.status, to: input.status, ...run });
  }
  if (assignee !== undefined && (assignee?.id ?? null) !== before.assignee_id) {
    await addEvent(id, actor, 'task_assigned', { assignee: assignee?.name ?? null });
  }
  const edited = (['title', 'description', 'priority', 'project', 'labels', 'level', 'kind', 'parent_id'] as const).filter(
    (c) => input[c] !== undefined && JSON.stringify(input[c]) !== JSON.stringify(before[c]),
  );
  if (edited.length) await addEvent(id, actor, 'task_edited', { fields: edited });

  return getTask(id);
}

export async function submitResult(
  actor: Actor,
  id: number,
  input: z.infer<typeof S.SubmitResult>,
): Promise<Row> {
  requireRunInfo(actor, input);
  const before = await assertTask(id);
  if (input.happened_at && Date.parse(input.happened_at) > Date.now() + 60_000) {
    throw new HttpError(400, 'happened_at is in the future');
  }
  await q(
    `update tasks set result = $2, result_by = $3, result_model = $4, result_effort = $5,
            result_at = coalesce($7::timestamptz, now()), status = $6::text,
            updated_at = coalesce($7::timestamptz, now()),
            started_at = coalesce(started_at, created_at),
            completed_at = case when $6::text = 'done' then coalesce($7::timestamptz, now()) else null end
      where id = $1`,
    [id, input.result, actor.id, input.model ?? null, input.effort ?? null, input.status, input.happened_at ?? null],
  );
  await addEvent(id, actor, 'result_submitted', {
    body: input.result,
    from: before.status,
    to: input.status,
    model: input.model ?? null,
    effort: input.effort ?? null,
  });
  return getTask(id);
}

// ---------- links ----------

export async function linkTasks(
  actor: Actor,
  taskId: number,
  input: z.infer<typeof S.LinkTasks>,
): Promise<Row> {
  if (input.to === taskId) throw new HttpError(400, 'a task cannot be linked to itself');
  await assertTask(taskId);
  const other = await q1('select id, title from tasks where id = $1', [input.to]);
  if (!other) throw new HttpError(404, `task ${input.to} not found`);

  const reversed = input.type === 'blocked_by' || input.type === 'duplicated_by';
  const type = input.type === 'blocked_by' ? 'blocks' : input.type === 'duplicated_by' ? 'duplicates' : input.type;
  const [from, to] = reversed ? [input.to, taskId] : [taskId, input.to];
  // "relates" reads the same both ways, and nothing may block what blocks it.
  const clash = await q1(
    `select 1 as one from task_links
      where type = $3 and ((from_task = $1 and to_task = $2) or (from_task = $2 and to_task = $1))`,
    [from, to, type],
  );
  if (clash) {
    throw new HttpError(409, `tasks ${taskId} and ${input.to} are already linked as "${type}"`);
  }
  await q('insert into task_links(from_task, to_task, type, created_by) values ($1, $2, $3, $4)', [
    from,
    to,
    type,
    actor.id,
  ]);
  await q('update tasks set updated_at = now() where id in ($1, $2)', [taskId, input.to]);
  await addEvent(taskId, actor, 'link_added', { type: input.type, task_id: input.to, title: other.title });
  return getTask(taskId);
}

export async function unlinkTasks(actor: Actor, taskId: number, linkId: number): Promise<Row> {
  const link = await q1(
    `delete from task_links where id = $1 and (from_task = $2 or to_task = $2)
     returning from_task, to_task, type`,
    [linkId, taskId],
  );
  if (!link) throw new HttpError(404, `link ${linkId} not found on task ${taskId}`);
  const otherId = link.from_task === taskId ? link.to_task : link.from_task;
  await addEvent(taskId, actor, 'link_removed', {
    type: link.from_task === taskId ? link.type : REVERSE[link.type],
    task_id: otherId,
  });
  return getTask(taskId);
}

// ---------- comments ----------

export async function addComment(
  actor: Actor,
  taskId: number,
  input: z.infer<typeof S.AddComment>,
): Promise<Row> {
  const { author, recorder, at } = await authorship(actor, input);
  const run: { model?: string; effort?: string } = recorder ? {} : input;
  requireRunInfo(author, run);
  await assertTask(taskId);
  const row = await q1(
    `insert into comments(task_id, author_id, body, model, effort, recorded_by, original_text, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now())) returning *`,
    [
      taskId,
      author.id,
      input.body,
      run.model ?? null,
      run.effort ?? null,
      recorder?.id ?? null,
      input.original_text ?? null,
      at,
    ],
  );
  await q('update tasks set updated_at = now() where id = $1', [taskId]);
  await addEvent(taskId, author, 'comment_added', {
    comment_id: row!.id,
    body: input.body,
    model: run.model ?? null,
    effort: run.effort ?? null,
    ...(recorder && { recorded_by: recorder.name }),
  });
  return {
    ...row,
    author_name: author.name,
    author_kind: author.kind,
    recorded_by_name: recorder?.name ?? null,
  };
}

// ---------- time ----------

const TIME_LOG_SELECT = `select l.*, a.name as account_name
                           from time_logs l join accounts a on a.id = l.account_id`;

export async function logTime(
  actor: Actor,
  taskId: number,
  input: z.infer<typeof S.LogTime>,
): Promise<Row> {
  requireRunInfo(actor, input);
  await assertTask(taskId);
  const row = await q1(
    `insert into time_logs(task_id, account_id, model, effort, seconds, started_at, ended_at,
                           note, input_tokens, output_tokens, cost_usd,
                           cache_read_tokens, cache_write_tokens, worker)
     values ($1, $2, $3, $4, $5::int,
             coalesce($6::timestamptz, now() - make_interval(secs => $5::int)),
             coalesce($6::timestamptz + make_interval(secs => $5::int), now()),
             $7, $8, $9, $10, $11, $12, $13)
     returning id`,
    [
      taskId,
      actor.id,
      input.model ?? null,
      input.effort ?? null,
      input.seconds,
      input.started_at ?? null,
      input.note ?? null,
      input.input_tokens ?? null,
      input.output_tokens ?? null,
      input.cost_usd ?? null,
      input.cache_read_tokens ?? null,
      input.cache_write_tokens ?? null,
      input.worker ?? null,
    ],
  );
  return (await q1(`${TIME_LOG_SELECT} where l.id = $1`, [row!.id]))!;
}

// Usage is often known only after the fact (from a transcript or a bill), so the
// author of an entry can correct it. Only fields that are sent change.
export async function updateTimeLog(
  actor: Actor,
  id: number,
  input: z.infer<typeof S.UpdateTimeLog>,
): Promise<Row> {
  const log = await q1('select account_id, ended_at from time_logs where id = $1', [id]);
  if (!log) throw new HttpError(404, `time log ${id} not found`);
  if (log.account_id !== actor.id && actor.role !== 'admin') {
    throw new HttpError(403, 'only the author or an admin can change a time log');
  }
  if (!log.ended_at && (input.seconds !== undefined || input.started_at !== undefined)) {
    throw new HttpError(409, 'stop the timer before changing its duration');
  }
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const col of ['note', 'worker', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd'] as const) {
    if (input[col] !== undefined) sets.push(`${col} = $${params.push(input[col])}`);
  }
  if (input.seconds !== undefined || input.started_at !== undefined) {
    // Right-hand sides see the row as it was, so the new end is spelled out from both inputs.
    const start = `coalesce($${params.push(input.started_at ?? null)}::timestamptz, started_at)`;
    const secs = `coalesce($${params.push(input.seconds ?? null)}::int, seconds)`;
    sets.push(`started_at = ${start}`, `seconds = ${secs}`);
    sets.push(`ended_at = ${start} + make_interval(secs => ${secs})`);
  }
  if (sets.length) await q(`update time_logs set ${sets.join(', ')} where id = $1`, params);
  return (await q1(`${TIME_LOG_SELECT} where l.id = $1`, [id]))!;
}

export async function startTimer(
  actor: Actor,
  taskId: number,
  input: z.infer<typeof S.StartTimer>,
): Promise<Row> {
  requireRunInfo(actor, input);
  const task = await assertTask(taskId);
  const row = await q1(
    `insert into time_logs(task_id, account_id, model, effort, note, worker)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      taskId,
      actor.id,
      input.model ?? null,
      input.effort ?? null,
      input.note ?? null,
      input.worker ?? null,
    ],
  );
  if (task.status === 'todo') {
    await updateTask(actor, taskId, { status: 'in_progress', ...input });
  }
  return (await q1(`${TIME_LOG_SELECT} where l.id = $1`, [row!.id]))!;
}

// Picks the timer to stop. With one running there is nothing to choose; with several the
// caller names it by id, or by what makes it different: worker, model, effort.
async function runningTimer(
  actor: Actor,
  taskId: number,
  input: z.infer<typeof S.StopTimer>,
): Promise<number> {
  const running = await q(
    `select id, model, effort, worker, started_at from time_logs
      where task_id = $1 and account_id = $2 and ended_at is null order by id`,
    [taskId, actor.id],
  );
  if (input.time_log_id !== undefined) {
    if (!running.some((l) => l.id === input.time_log_id)) {
      throw new HttpError(404, `timer ${input.time_log_id} is not running on task ${taskId}`);
    }
    return input.time_log_id;
  }
  if (!running.length) throw new HttpError(404, `no running timer on task ${taskId}`);
  const same = running.filter(
    (l) =>
      (input.worker === undefined || l.worker === input.worker) &&
      (input.model === undefined || l.model === input.model) &&
      (input.effort === undefined || l.effort === input.effort),
  );
  if (same.length === 1) return same[0]!.id;
  const list = running
    .map((l) => `${l.id} (${[l.worker, l.model, l.effort].filter(Boolean).join(', ')})`)
    .join('; ');
  throw new HttpError(409, `several timers are running on task ${taskId}, pass time_log_id: ${list}`);
}

export async function stopTimer(
  actor: Actor,
  taskId: number,
  input: z.infer<typeof S.StopTimer>,
): Promise<Row> {
  const id = await runningTimer(actor, taskId, input);
  await q(
    `update time_logs set
        ended_at = now(),
        seconds = greatest(1, round(extract(epoch from now() - started_at))::int),
        note = coalesce($2, note),
        input_tokens = $3, output_tokens = $4, cost_usd = $5,
        cache_read_tokens = $6, cache_write_tokens = $7
      where id = $1`,
    [
      id,
      input.note ?? null,
      input.input_tokens ?? null,
      input.output_tokens ?? null,
      input.cost_usd ?? null,
      input.cache_read_tokens ?? null,
      input.cache_write_tokens ?? null,
    ],
  );
  return (await q1(`${TIME_LOG_SELECT} where l.id = $1`, [id]))!;
}

// ---------- attachments ----------

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.log': 'text/plain',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.jsonl': 'application/jsonl',
  '.csv': 'text/csv',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

function detectMime(filename: string, declared?: string): string {
  const byExt = MIME_BY_EXT[extname(filename).toLowerCase()];
  if (byExt) return byExt;
  if (declared && declared !== 'application/octet-stream' && /^[\w.+-]+\/[\w.+-]+/.test(declared)) {
    return declared.split(';')[0]!.trim().toLowerCase();
  }
  return 'application/octet-stream';
}

export function isTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    ['application/json', 'application/jsonl', 'application/xml', 'application/yaml'].includes(mime)
  );
}

function kindOf(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (isTextMime(mime)) return 'log';
  return 'file';
}

export async function addAttachment(
  actor: Actor,
  taskId: number,
  file: { filename: string; mime?: string; stream: Readable; commentId?: number },
): Promise<Row> {
  await assertTask(taskId);
  const filename = file.filename.replace(/[/\\\0]/g, '_').slice(-200) || 'file';
  if (file.commentId !== undefined) {
    const c = await q1('select 1 from comments where id = $1 and task_id = $2', [
      file.commentId,
      taskId,
    ]);
    if (!c) throw new HttpError(404, `comment ${file.commentId} not found on task ${taskId}`);
  }

  await mkdir(attachmentsDir, { recursive: true });
  const storageKey = randomUUID();
  const path = join(attachmentsDir, storageKey);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > config.maxUploadBytes) {
        cb(new HttpError(413, `file exceeds ${config.maxUploadBytes} bytes`));
      } else {
        cb(null, chunk);
      }
    },
  });
  try {
    await pipeline(file.stream, limiter, createWriteStream(path));
    if (size === 0) throw new HttpError(400, 'empty file');
    const mime = detectMime(filename, file.mime);
    const row = await q1(
      `insert into attachments(task_id, comment_id, account_id, filename, mime, size, kind, storage_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [taskId, file.commentId ?? null, actor.id, filename, mime, size, kindOf(mime), storageKey],
    );
    await q('update tasks set updated_at = now() where id = $1', [taskId]);
    await addEvent(taskId, actor, 'attachment_added', {
      attachment_id: row!.id,
      filename,
      kind: row!.kind,
      size,
    });
    return attachmentRow({ ...row, account_name: actor.name });
  } catch (err) {
    await rm(path, { force: true });
    throw err;
  }
}

export async function getAttachment(id: number): Promise<{ row: Row; path: string }> {
  const row = await q1('select * from attachments where id = $1', [id]);
  if (!row) throw new HttpError(404, `attachment ${id} not found`);
  const path = join(attachmentsDir, row.storage_key);
  await stat(path).catch(() => {
    throw new HttpError(410, 'attachment content is missing from storage');
  });
  return { row: attachmentRow(row), path };
}

export async function readAttachmentBytes(
  path: string,
  size: number,
  opts: { maxBytes: number; tail?: boolean },
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const length = Math.min(size, opts.maxBytes);
  const fh = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, opts.tail ? size - length : 0);
    return { buffer, truncated: length < size };
  } finally {
    await fh.close();
  }
}

export { createReadStream };

// ---------- inbox ----------

const EVENT_SELECT = `
  select e.*, t.title as task_title, t.project, asg.name as assignee_name,
         ac.name as actor_name, ac.kind as actor_kind
    from events e
    join tasks t on t.id = e.task_id
    join accounts ac on ac.id = e.actor_id
    left join accounts asg on asg.id = t.assignee_id`;

// Everything other accounts did on tasks the caller is involved in (assignee, creator,
// commenter, time logger) or where the caller is @mentioned, since the last ack.
// People also oversee the agents: they see every new task, every submitted result and
// every task that went to review or got blocked, whoever it belongs to.
// `after` lets a watcher read on from the last event it has seen without acknowledging
// anything: what is acknowledged stays the business of the agent itself.
export async function getInbox(
  actor: Actor,
  { after = 0, limit = 100 }: { after?: number; limit?: number } = {},
): Promise<{ cursor: number; events: Row[] }> {
  const me = await q1('select inbox_cursor from accounts where id = $1', [actor.id]);
  const events = await q(
    `${EVENT_SELECT}
      where e.id > greatest($1::bigint, $6::bigint) and e.actor_id <> $2
        and e.data->>'history' is null
        and (e.type <> 'agent_run' or ($5 = 'human' and e.data->>'state' = 'failed'))
        and not exists (select 1 from inbox_reads r
                         where r.account_id = $2 and r.task_id = e.task_id and r.up_to >= e.id)
        and coalesce(e.data->>'recorded_by', '') <> $3
        and (t.assignee_id = $2 or t.created_by = $2
             or exists (select 1 from comments c where c.task_id = t.id and c.author_id = $2)
             or exists (select 1 from time_logs l where l.task_id = t.id and l.account_id = $2)
             or position(lower('@' || $3) in lower(coalesce(e.data->>'body', ''))) > 0
             or ($5 = 'human' and (e.type in ('task_created', 'result_submitted')
                 or e.type = 'agent_run'
                 or (e.type = 'status_changed' and e.data->>'to' in ('review', 'blocked')))))
      order by e.id
      limit $4`,
    [me!.inbox_cursor, actor.id, actor.name, limit, actor.kind, after],
  );
  return { cursor: me!.inbox_cursor, events };
}

/** An agent was started for the task by the watcher on the person's computer, or has ended. */
export async function reportRun(actor: Actor, taskId: number, input: z.infer<typeof S.ReportRun>): Promise<Row> {
  if (actor.kind !== 'agent') throw new HttpError(403, 'only agents report their runs');
  await assertTask(taskId);
  await addEvent(taskId, actor, 'agent_run', input);
  return { ok: true };
}

/** Everything that has happened in the task so far is read; what comes later is news again. */
export async function readTask(actor: Actor, taskId: number): Promise<{ ok: true }> {
  await assertTask(taskId);
  await q(
    `insert into inbox_reads(account_id, task_id, up_to)
     select $1::int, $2::int, coalesce(max(id), 0) from events where task_id = $2::int
     on conflict (account_id, task_id) do update set up_to = excluded.up_to`,
    [actor.id, taskId],
  );
  return { ok: true };
}

export async function ackInbox(actor: Actor, upTo: number): Promise<{ cursor: number }> {
  const max = await q1('select coalesce(max(id), 0) as max from events');
  const row = await q1(
    `update accounts set inbox_cursor = greatest(inbox_cursor, least($2::bigint, $3::bigint))
      where id = $1 returning inbox_cursor`,
    [actor.id, upTo, max!.max],
  );
  return { cursor: row!.inbox_cursor };
}

export async function recentActivity(limit = 50): Promise<Row[]> {
  return q(`${EVENT_SELECT} order by e.id desc limit $1`, [limit]);
}

// ---------- analytics ----------

const GROUP_EXPR: Record<(typeof S.GROUP_BYS)[number], string> = {
  worker: 'l.worker',
  model: 'l.model',
  effort: 'l.effort',
  account: 'a.name',
  system: 'a.system',
  project: 't.project',
  day: `to_char(l.started_at at time zone 'UTC', 'YYYY-MM-DD')`,
  task: `'#' || t.id || ' ' || t.title`,
};

const AGG = `coalesce(sum(l.seconds), 0) as seconds,
             count(*) as entries,
             count(distinct l.task_id) as tasks,
             coalesce(sum(l.input_tokens), 0) as input_tokens,
             coalesce(sum(l.output_tokens), 0) as output_tokens,
             coalesce(sum(l.cache_read_tokens), 0) as cache_read_tokens,
             coalesce(sum(l.cache_write_tokens), 0) as cache_write_tokens,
             count(*) filter (where l.input_tokens is null) as unknown_input_tokens_entries,
             count(*) filter (where l.output_tokens is null) as unknown_output_tokens_entries,
             count(*) filter (where l.cache_read_tokens is null) as unknown_cache_read_tokens_entries,
             count(*) filter (where l.cache_write_tokens is null) as unknown_cache_write_tokens_entries,
             count(*) filter (where l.input_tokens is null or l.output_tokens is null) as unknown_tokens_entries,
             count(*) - count(l.cost_usd) as unpriced_entries,
             coalesce(sum(l.cost_usd), 0) as cost_usd`;

export async function analytics(input: z.infer<typeof S.Analytics>): Promise<Row> {
  const groupBy = input.group_by.split(',').map((s) => s.trim()).filter(Boolean);
  if (groupBy.length < 1 || groupBy.length > 2) {
    throw new HttpError(400, 'group_by takes one or two dimensions');
  }
  for (const g of groupBy) {
    if (!(g in GROUP_EXPR)) {
      throw new HttpError(400, `unknown group_by "${g}"; use ${S.GROUP_BYS.join(', ')}`);
    }
  }
  const exprs = groupBy.map((g) => GROUP_EXPR[g as keyof typeof GROUP_EXPR]);

  const params: unknown[] = [];
  const where = ['l.seconds is not null'];
  if (input.from) where.push(`l.started_at >= $${params.push(input.from)}`);
  if (input.to) where.push(`l.started_at < $${params.push(input.to)}`);
  if (input.project) where.push(`t.project = $${params.push(input.project)}`);
  const from = `from time_logs l
                join accounts a on a.id = l.account_id
                join tasks t on t.id = l.task_id
               where ${where.join(' and ')}`;

  const taskWhere = input.project ? 'where project = $1' : '';
  const [rows, totals, statuses] = await Promise.all([
    q(
      `select ${exprs.map((e, i) => `${e} as k${i}`).join(', ')}, ${AGG}
         ${from}
        group by ${exprs.map((_, i) => i + 1).join(', ')}
        order by ${groupBy[0] === 'day' ? '1' : 'seconds desc'}
        limit 1000`,
      params,
    ),
    q1(`select ${AGG} ${from}`, params),
    q(
      `select status, count(*) as n from tasks ${taskWhere} group by status`,
      input.project ? [input.project] : [],
    ),
  ]);

  return {
    group_by: groupBy,
    from: input.from ?? null,
    to: input.to ?? null,
    totals,
    rows: rows.map(({ k0, k1, ...rest }) => ({
      keys: groupBy.length === 2 ? [k0 ?? null, k1 ?? null] : [k0 ?? null],
      ...rest,
    })),
    tasks_by_status: Object.fromEntries(statuses.map((s) => [s.status, s.n])),
  };
}

const logosDir = join(config.dataDir, 'logos');
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const LOGO_LIMIT = 5 * 1024 * 1024;

// When the work on each task actually happened, by day. Tasks without logged time are
// placed by their own dates, so planned and untracked work is visible too.
export async function timeline(input: z.infer<typeof S.Timeline>): Promise<Row> {
  const params: unknown[] = [input.tz];
  const where: string[] = [];
  if (input.project) where.push(`lower(t.project) = lower($${params.push(input.project)})`);
  if (input.from) where.push(`coalesce(w.last_at, t.completed_at, t.updated_at) >= $${params.push(input.from)}`);
  if (input.to) where.push(`coalesce(w.first_at, t.started_at, t.created_at) < $${params.push(input.to)}`);
  const tasks = await q(
    `select t.id, t.title, t.level, t.kind, t.status, t.parent_id, t.project, a.name as assignee_name,
            coalesce(w.first_at, t.started_at, t.created_at) as started_at,
            coalesce(w.last_at, t.completed_at, case when t.status in ('done', 'cancelled') then t.updated_at end) as ended_at,
            coalesce(w.seconds, 0) as seconds,
            coalesce(w.days, '{}'::jsonb) as days
       from tasks t
       left join accounts a on a.id = t.assignee_id
       left join lateral (
         select min(d.first_at) as first_at, max(d.last_at) as last_at, sum(d.seconds) as seconds,
                jsonb_object_agg(d.day, d.seconds) as days
           from (
             select to_char(l.started_at at time zone $1, 'YYYY-MM-DD') as day,
                    min(l.started_at) as first_at,
                    max(coalesce(l.ended_at, now())) as last_at,
                    sum(coalesce(l.seconds, 0)) as seconds
               from time_logs l
              where l.task_id = t.id
              group by 1
           ) d
       ) w on true
      ${where.length ? 'where ' + where.join(' and ') : ''}
      order by started_at, t.id
      limit 5000`,
    params,
  );
  return { tz: input.tz, tasks };
}

export async function listProjectDetails(): Promise<Row[]> {
  const rows = await q(
    `select p.id, p.name, p.description, p.color, p.created_at, p.updated_at, p.logo_key,
            a.name as created_by_name,
            (select count(*) from tasks t where lower(t.project) = lower(p.name)) as tasks,
            (select count(*) from tasks t where lower(t.project) = lower(p.name)
                and t.status not in ('done', 'cancelled')) as open_tasks,
            coalesce((select jsonb_object_agg(status, n) from
               (select status, count(*) as n from tasks t
                 where lower(t.project) = lower(p.name) group by status) s), '{}') as tasks_by_status,
            (select max(t.updated_at) from tasks t where lower(t.project) = lower(p.name)) as last_activity_at,
            coalesce((select sum(l.seconds) from time_logs l join tasks t on t.id = l.task_id
                       where lower(t.project) = lower(p.name)), 0) as total_seconds,
            coalesce((select sum(l.cost_usd) from time_logs l join tasks t on t.id = l.task_id
                       where lower(t.project) = lower(p.name)), 0) as cost_usd,
            coalesce((select jsonb_agg(distinct jsonb_build_object('name', m.name, 'kind', m.kind))
                        from tasks t
                        join accounts m on m.id in (t.created_by, t.assignee_id)
                       where lower(t.project) = lower(p.name)), '[]') as members,
            coalesce((select jsonb_agg(distinct l.model) from time_logs l join tasks t on t.id = l.task_id
                       where lower(t.project) = lower(p.name) and l.model is not null), '[]') as models
       from projects p
       left join accounts a on a.id = p.created_by
      order by last_activity_at desc nulls last, p.name`,
  );
  return rows.map(({ logo_key, updated_at, ...p }) => ({
    ...p,
    // The version in the URL lets browsers cache the image until it is replaced.
    logo_url: logo_key ? `/api/projects/${p.id}/logo?v=${logo_key.slice(0, 8)}` : null,
  }));
}

export async function listProjects(): Promise<string[]> {
  return (await listProjectDetails()).map((p) => p.name);
}

export async function getProject(ref: string | number): Promise<Row> {
  const all = await listProjectDetails();
  const found =
    typeof ref === 'number'
      ? all.find((p) => p.id === ref)
      : all.find((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (!found) throw new HttpError(404, `project "${ref}" not found`);
  return found;
}

export async function createProject(
  actor: Actor,
  input: z.infer<typeof S.CreateProject>,
): Promise<Row> {
  try {
    await q('insert into projects(name, description, color, created_by) values ($1, $2, $3, $4)', [
      input.name,
      input.description,
      input.color ?? null,
      actor.id,
    ]);
  } catch (err: any) {
    if (err.code === '23505') throw new HttpError(409, `project "${input.name}" already exists`);
    throw err;
  }
  return getProject(input.name);
}

export async function updateProject(
  id: number,
  input: z.infer<typeof S.UpdateProject>,
): Promise<Row> {
  const before = await q1('select name from projects where id = $1', [id]);
  if (!before) throw new HttpError(404, `project ${id} not found`);
  const sets = ['updated_at = now()'];
  const params: unknown[] = [id];
  for (const col of ['name', 'description', 'color'] as const) {
    if (input[col] !== undefined) sets.push(`${col} = $${params.push(input[col])}`);
  }
  try {
    await q(`update projects set ${sets.join(', ')} where id = $1`, params);
  } catch (err: any) {
    if (err.code === '23505') throw new HttpError(409, `project "${input.name}" already exists`);
    throw err;
  }
  // Tasks refer to their project by name, so a rename has to follow them.
  if (input.name !== undefined && input.name !== before.name) {
    await q('update tasks set project = $1 where lower(project) = lower($2)', [input.name, before.name]);
  }
  return getProject(id);
}

export async function setProjectLogo(
  id: number,
  file: { mime?: string; stream: Readable },
): Promise<Row> {
  const project = await q1('select logo_key from projects where id = $1', [id]);
  if (!project) throw new HttpError(404, `project ${id} not found`);
  const mime = (file.mime ?? '').split(';')[0]!.trim().toLowerCase();
  if (!LOGO_TYPES.includes(mime)) throw new HttpError(415, 'logo must be a PNG, JPEG or WebP image');

  await mkdir(logosDir, { recursive: true });
  const key = randomUUID();
  const path = join(logosDir, key);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      cb(size > LOGO_LIMIT ? new HttpError(413, 'logo is larger than 5 MB') : null, chunk);
    },
  });
  try {
    await pipeline(file.stream, limiter, createWriteStream(path));
    if (size === 0) throw new HttpError(400, 'empty file');
  } catch (err) {
    await rm(path, { force: true });
    throw err;
  }
  await q('update projects set logo_key = $2, logo_mime = $3, updated_at = now() where id = $1', [
    id,
    key,
    mime,
  ]);
  if (project.logo_key) await rm(join(logosDir, project.logo_key), { force: true });
  return getProject(id);
}

export async function getProjectLogo(id: number): Promise<{ path: string; mime: string }> {
  const row = await q1('select logo_key, logo_mime from projects where id = $1', [id]);
  if (!row?.logo_key) throw new HttpError(404, 'this project has no logo');
  return { path: join(logosDir, row.logo_key), mime: row.logo_mime };
}

// Tasks may name a project that does not exist yet; it is created on the spot, and an
// existing one is matched regardless of letter case so "drop" and "Drop" do not split.
async function resolveProject(actor: Actor, name: string | null | undefined): Promise<string | null> {
  if (!name) return null;
  const row = await q1(
    `insert into projects(name, created_by) values ($1, $2)
     on conflict (lower(name)) do update set name = projects.name
     returning name`,
    [name, actor.id],
  );
  return row!.name;
}

export async function accountsExist(): Promise<boolean> {
  return !!(await q1('select 1 as one from accounts limit 1'));
}

export { pool };
