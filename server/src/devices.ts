import { pool, q, q1, type Row } from './db.ts';
import { hashKey, SESSION_PREFIX, type Actor } from './auth.ts';
import { HttpError } from './errors.ts';
import { DeviceInput, type DeviceRegistration } from './schemas.ts';

const platforms: Record<string,string> = {macos:'Mac',windows:'Windows',linux:'Linux',ios:'iPhone / iPad',android:'Android',unknown:'Устройство'};
export function fromUserAgent(ua=''): Omit<DeviceRegistration,'installation_id'> {
  const platform = /iPhone|iPad/i.test(ua)?'ios':/Android/i.test(ua)?'android':/Macintosh|Mac OS/i.test(ua)?'macos':/Windows/i.test(ua)?'windows':/Linux/i.test(ua)?'linux':'unknown';
  return {platform,client_type:/iPhone|iPad|Android|Mobile/i.test(ua)?'mobile_browser':'desktop_browser'};
}
export function fromHeaders(headers: Record<string,unknown>): DeviceRegistration|undefined {
  if (headers['x-device-id']===undefined && headers['x-client-type']===undefined && headers['x-client-platform']===undefined) return;
  const result=DeviceInput.safeParse({installation_id:headers['x-device-id'],client_type:headers['x-client-type'],platform:headers['x-client-platform']});
  if (!result.success) throw new HttpError(400,'invalid device metadata');
  return result.data;
}
function sessionActor(actor:Actor,credential?:string) {
  if(actor.kind!=='human'||!credential?.startsWith(SESSION_PREFIX)) throw new HttpError(403,'Для управления устройствами войдите в браузере или приложении');
}

/** An installation id describes the client; it never authenticates or bypasses 2FA. */
export async function associate(actor:Actor,credential:string|undefined,input:DeviceRegistration|undefined,userAgent?:string):Promise<number|undefined> {
  if(actor.kind!=='human'||!credential?.startsWith(SESSION_PREFIX)) return;
  const client=await pool.connect();
  try{
    await client.query('begin');
    // Lock account before its sessions/devices, also used by revocation and 2FA changes.
    await client.query('select id from accounts where id=$1 for update',[actor.id]);
    const session=(await client.query(`select s.* from sessions s join accounts a on a.id=s.account_id
      where s.token_hash=$1 and s.account_id=$2 and s.expires_at>now() and not a.disabled for update of s`,[hashKey(credential),actor.id])).rows[0];
    if(!session) throw new HttpError(401,'session expired');
    let device:Row|undefined=session.device_id?(await client.query('select * from account_devices where id=$1 and account_id=$2',[session.device_id,actor.id])).rows[0]:undefined;
    // A session stays on its device; changing a header cannot move it to a different one.
    if(!device || (!device.installation_id && input)){
      const descriptor=input??fromUserAgent(userAgent);
      const result=await client.query(`insert into account_devices(account_id,installation_id,name,client_type,platform)
        values($1,$2,$3,$4,$5) on conflict(account_id,installation_id) do update
        set client_type=excluded.client_type,platform=excluded.platform,last_used_at=now() returning *`,
        [actor.id,input?.installation_id??null,platforms[descriptor.platform],descriptor.client_type,descriptor.platform]);
      device=result.rows[0];
      await client.query('update sessions set device_id=$1 where id=$2',[device!.id,session.id]);
    }else{
      await client.query(`update account_devices set last_used_at=now(),
        client_type=case when installation_id=$2::uuid then $3 else client_type end,
        platform=case when installation_id=$2::uuid then $4 else platform end where id=$1`,
        [device.id,input?.installation_id??null,input?.client_type??device.client_type,input?.platform??device.platform]);
    }
    await client.query('commit');return Number(device!.id);
  }catch(error){await client.query('rollback');throw error;}
  finally{client.release();}
}

export async function list(actor:Actor,credential:string|undefined) {
  sessionActor(actor,credential);
  return q(`select d.id,d.name,d.client_type,d.platform,d.created_at,d.last_used_at,
    count(s.id)::int as sessions, bool_or(s.token_hash=$2) as current,
    array_agg(distinct s.method order by s.method) as sign_in_methods
    from account_devices d join sessions s on s.device_id=d.id and s.expires_at>now()
    where d.account_id=$1 group by d.id order by current desc,d.last_used_at desc,d.id desc`,[actor.id,hashKey(credential!)]);
}
export async function rename(actor:Actor,credential:string|undefined,id:number,name:string) {
  sessionActor(actor,credential);
  const result=await q1('update account_devices set name=$3 where id=$1 and account_id=$2 returning id,name',[id,actor.id,name]);
  if(!result)throw new HttpError(404,'Устройство не найдено');
  return result;
}
export async function revoke(actor:Actor,credential:string|undefined,id:number) {
  sessionActor(actor,credential);
  // Cascade revokes every session and notification subscription bound to this device.
  const client=await pool.connect();
  try{
    await client.query('begin');await client.query('select id from accounts where id=$1 for update',[actor.id]);
    const result=await client.query('delete from account_devices where id=$1 and account_id=$2 returning id',[id,actor.id]);
    if(!result.rowCount)throw new HttpError(404,'Устройство не найдено');
    await client.query('commit');return {ok:true};
  }catch(error){await client.query('rollback');throw error;}
  finally{client.release();}
}
