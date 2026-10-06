import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool, q, q1, type Row } from './db.ts';
import type { Actor } from './auth.ts';
import { HttpError } from './errors.ts';
import type * as S from './schemas.ts';

const pageSelect = `select w.*, c.name as created_by_name, u.name as updated_by_name
  from wiki_pages w left join accounts c on c.id = w.created_by
  left join accounts u on u.id = w.updated_by`;

export async function listPages(projectId: number): Promise<Row[]> {
  if (!await q1('select id from projects where id = $1', [projectId])) throw new HttpError(404, 'project not found');
  const pages = await q(`${pageSelect} where w.project_id = $1 order by lower(w.title), w.id`, [projectId]);
  return pages.map(({ content, ...page }) => page);
}

export async function getPage(projectId: number, pageId: number): Promise<Row> {
  const page = await q1(`${pageSelect} where w.project_id = $1 and w.id = $2`, [projectId, pageId]);
  if (!page) throw new HttpError(404, 'wiki page not found');
  return page;
}

// Serialize tree mutations per project, including concurrent moves/deletes. A check
// followed by an unlocked update would allow two valid moves to create a cycle.
async function mutate<T>(actor: Actor, projectId: number, info: { model?: string; effort?: string },
  work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (actor.kind === 'agent' && (!info.model || !info.effort)) throw new HttpError(400, 'agent accounts must provide both "model" and "effort"');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const project = await client.query('select id from projects where id = $1 for update', [projectId]);
    if (!project.rowCount) throw new HttpError(404, 'project not found');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

async function checkParent(client: PoolClient, projectId: number, parentId: number | null, pageId?: number): Promise<void> {
  if (parentId === null) return;
  const parent = await client.query('select id from wiki_pages where project_id = $1 and id = $2', [projectId, parentId]);
  if (!parent.rowCount) throw new HttpError(400, 'parent page must belong to the same project');
  if (pageId === undefined) return;
  const cycle = await client.query(`with recursive ancestors as (
    select id, parent_id from wiki_pages where project_id = $1 and id = $2
    union all select w.id, w.parent_id from wiki_pages w join ancestors a on w.id = a.parent_id where w.project_id = $1
  ) select id from ancestors where id = $3`, [projectId, parentId, pageId]);
  if (cycle.rowCount) throw new HttpError(400, 'a page cannot be nested inside itself or its descendants');
}

async function current(client: PoolClient, projectId: number, pageId: number, revision: number): Promise<Row> {
  const { rows: [page] } = await client.query('select * from wiki_pages where project_id = $1 and id = $2', [projectId, pageId]);
  if (!page) throw new HttpError(404, 'wiki page not found');
  if (page.revision !== revision) throw new HttpError(409, 'wiki page changed; reload before saving');
  return page;
}

export async function createPage(actor: Actor, projectId: number, input: z.infer<typeof S.CreateWikiPage>): Promise<Row> {
  const id = await mutate(actor, projectId, input, async (client) => {
    await checkParent(client, projectId, input.parent_id);
    const { rows: [page] } = await client.query(`insert into wiki_pages(project_id, parent_id, title, content, created_by, updated_by, model, effort)
      values ($1,$2,$3,$4,$5,$5,$6,$7) returning id`, [projectId,input.parent_id,input.title,input.content,actor.id,input.model ?? null,input.effort ?? null]);
    return page.id;
  });
  return getPage(projectId, id);
}

export async function updatePage(actor: Actor, projectId: number, pageId: number, input: z.infer<typeof S.UpdateWikiPage>): Promise<Row> {
  await mutate(actor, projectId, input, async (client) => {
    const page = await current(client, projectId, pageId, input.revision);
    const parentId = input.parent_id === undefined ? page.parent_id : input.parent_id;
    await checkParent(client, projectId, parentId, pageId);
    await client.query(`update wiki_pages set title=$3, content=$4, parent_id=$5,
      revision=revision+1, updated_by=$6, updated_at=now(), model=$7, effort=$8 where project_id=$1 and id=$2`,
    [projectId,pageId,input.title ?? page.title,input.content ?? page.content,parentId,actor.id,input.model ?? null,input.effort ?? null]);
  });
  return getPage(projectId, pageId);
}

export async function deletePage(actor: Actor, projectId: number, pageId: number, input: z.infer<typeof S.DeleteWikiPage>): Promise<{ ok: true }> {
  await mutate(actor, projectId, input, async (client) => {
    const page = await current(client, projectId, pageId, input.revision);
    await client.query(`update wiki_pages set parent_id=$3, revision=revision+1, updated_by=$4, updated_at=now(), model=$5, effort=$6
      where project_id=$1 and parent_id=$2`, [projectId,pageId,page.parent_id,actor.id,input.model ?? null,input.effort ?? null]);
    await client.query('delete from wiki_pages where project_id=$1 and id=$2', [projectId,pageId]);
  });
  return { ok: true };
}
