// OpenAPI document generated from the zod schemas, for client codegen (e.g. Swift).
import { z } from 'zod';
import * as S from './schemas.ts';

type Op = {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  query?: z.ZodObject;
  body?: z.ZodType;
  response?: z.ZodType;
  admin?: boolean;
  public?: boolean;
};

const WithKey = z.object({ account: S.Account, key: z.string() });

const ops: Op[] = [
  {method:'post',path:'/api/push/test',summary:'Send a test Web Push to your own subscription',body:S.PushSubscription.pick({endpoint:true}),response:z.object({ok:z.boolean()})},
  {method:'get',path:'/api/devices',summary:'Your active devices; installation metadata is descriptive, not authentication',response:z.array(S.AccountDevice)},
  {method:'patch',path:'/api/devices/{id}',summary:'Rename your device',body:S.RenameDevice,response:z.object({id:z.number(),name:z.string()})},
  {method:'delete',path:'/api/devices/{id}',summary:'Revoke all sessions and linked notification subscriptions of your device',response:z.object({ok:z.boolean()})},
  {method:'get',path:'/api/auth/2fa/pending',summary:'Inspect pending sign-in using HttpOnly cookie or X-2FA-Challenge',public:true},
  {method:'delete',path:'/api/auth/2fa/pending',summary:'Cancel pending sign-in',public:true},
  {method:'post',path:'/api/auth/2fa/send',summary:'Send a second-step code to an enrolled channel',body:S.TwoFactorSend,public:true},
  {method:'post',path:'/api/auth/2fa/verify',summary:'Consume the code and create a full session',body:S.TwoFactorVerify,public:true},
  {method:'get',path:'/api/auth/2fa/settings',summary:'List your second-step channels'},
  {method:'post',path:'/api/auth/2fa/enroll',summary:'Send enrollment code; recent session required',body:S.TwoFactorEnroll},
  {method:'post',path:'/api/auth/2fa/enroll/verify',summary:'Confirm channel and revoke other sessions',body:S.TwoFactorEnrollmentVerify},
  {method:'delete',path:'/api/auth/2fa/settings/{channel}',summary:'Remove channel; recent confirmation required'},
  {method:'post',path:'/api/accounts/{id}/reset-2fa',summary:'Reset second-step channels and revoke all sessions',admin:true},
  { method: 'post', path: '/api/accounts/{id}/invitation', summary: 'Issue a one-use invitation; replaces the previous link', response: S.AccountInvitation, admin: true },
  { method: 'post', path: '/api/auth/invitations/inspect', summary: 'Inspect an unused invitation', body: S.InvitationToken, response: z.object({ name: z.string(), expires_at: z.string().describe('ISO 8601 timestamp') }), public: true },
  { method: 'post', path: '/api/auth/{provider}/start', summary: 'Start OAuth login, authenticated linking, or invitation redemption', body: S.AuthStart, response: z.object({ authorization_url: z.string() }), public: true },
  { method: 'post', path: '/api/auth/exchange', summary: 'Redeem a native code; returns session or second-step challenge', body: S.AuthExchange, response: z.union([z.object({ session_token: z.string() }), z.object({ ok: z.boolean() }),z.object({two_factor_required:z.literal(true),challenge_token:S.AuthToken,methods:z.array(z.object({channel:S.TwoFactorChannel,masked:z.string(),available:z.boolean()})),expires_at:z.string()})]), public: true },
  { method: 'get', path: '/api/auth/identities', summary: 'List your linked sign-in providers', response: z.array(S.AuthIdentity) },
  { method: 'delete', path: '/api/auth/identities/{provider}', summary: 'Unlink a provider and revoke its sessions', response: z.object({ ok: z.boolean() }) },
  { method: 'get', path: '/api/me', summary: 'Current account', response: S.Account },
  { method: 'get', path: '/api/accounts', summary: 'List accounts', response: z.array(S.Account) },
  { method: 'post', path: '/api/accounts', summary: 'Create account; returns the key once', body: S.CreateAccount, response: WithKey, admin: true },
  { method: 'patch', path: '/api/accounts/{id}', summary: 'Update account', body: S.UpdateAccount, response: S.Account, admin: true },
  { method: 'post', path: '/api/accounts/{id}/rotate-key', summary: 'Issue a new key', response: WithKey },
  { method: 'get', path: '/api/tasks', summary: 'List tasks', query: S.ListTasks, response: z.array(S.Task) },
  { method: 'post', path: '/api/tasks', summary: 'Create task', body: S.CreateTask, response: S.TaskDetail },
  { method: 'get', path: '/api/tasks/{id}', summary: 'Task with comments, time logs, attachments, events', response: S.TaskDetail },
  { method: 'patch', path: '/api/tasks/{id}', summary: 'Update task', body: S.UpdateTask, response: S.TaskDetail },
  { method: 'post', path: '/api/tasks/{id}/links', summary: 'Link this task to another', body: S.LinkTasks, response: S.TaskDetail },
  { method: 'delete', path: '/api/tasks/{id}/links/{linkId}', summary: 'Remove a link', response: S.TaskDetail },
  { method: 'post', path: '/api/tasks/{id}/result', summary: 'Submit result', body: S.SubmitResult, response: S.TaskDetail },
  { method: 'post', path: '/api/tasks/{id}/comments', summary: 'Add comment', body: S.AddComment, response: S.Comment },
  { method: 'post', path: '/api/tasks/{id}/time', summary: 'Log time', body: S.LogTime, response: S.TimeLog },
  { method: 'post', path: '/api/tasks/{id}/timer/start', summary: 'Start timer', body: S.StartTimer, response: S.TimeLog },
  { method: 'post', path: '/api/tasks/{id}/timer/stop', summary: 'Stop timer', body: S.StopTimer, response: S.TimeLog },
  { method: 'post', path: '/api/tasks/{id}/attachments', summary: 'Upload file: multipart/form-data (field "file"), or raw body with ?filename=', response: z.array(S.Attachment) },
  { method: 'get', path: '/api/attachments/{id}/content', summary: 'Download attachment (supports Range)' },
  { method: 'get', path: '/api/inbox', summary: 'Unacknowledged events from others on tasks you are involved in', query: S.ReadInbox, response: z.object({ cursor: z.number(), events: z.array(S.Event) }) },
  { method: 'post', path: '/api/tasks/{id}/runs', summary: 'Report that an agent was started for the task, or has ended', body: S.ReportRun, response: z.object({ ok: z.boolean() }) },
  { method: 'post', path: '/api/inbox/read', summary: 'Mark the events of one task as read', body: S.ReadTask, response: z.object({ ok: z.boolean() }) },
  { method: 'post', path: '/api/inbox/ack', summary: 'Acknowledge inbox events', body: S.AckInbox, response: z.object({ cursor: z.number() }) },
  { method: 'get', path: '/api/activity', summary: 'Recent events across all tasks', response: z.array(S.Event) },
  { method: 'get', path: '/api/timeline', summary: 'When the work on each task happened, by day', query: S.Timeline },
  { method: 'get', path: '/api/analytics', summary: 'Aggregated time, tokens and cost', query: S.Analytics, response: S.AnalyticsResult },
  { method: 'get', path: '/api/projects', summary: 'Project names; with ?details=1, projects with task counts and time', response: z.array(z.string()) },
  { method: 'post', path: '/api/projects', summary: 'Create project', body: S.CreateProject, response: S.Project },
  { method: 'get', path: '/api/projects/{id}', summary: 'Project with counters', response: S.Project },
  { method: 'patch', path: '/api/projects/{id}', summary: 'Rename, describe or recolour a project', body: S.UpdateProject, response: S.Project },
  { method: 'put', path: '/api/projects/{id}/logo', summary: 'Set the logo: raw PNG, JPEG or WebP body, up to 5 MB', response: S.Project },
  { method: 'get', path: '/api/projects/{id}/logo', summary: 'Project logo' },
  { method: 'patch', path: '/api/time-logs/{id}', summary: 'Correct your own time log: duration, tokens, cost', body: S.UpdateTimeLog, response: S.TimeLog },
];

const json = (schema: z.ZodType, io: 'input' | 'output') =>
  z.toJSONSchema(schema, { io, target: 'openapi-3.0', unrepresentable: 'any' });

export function buildOpenApi(): object {
  const paths: Record<string, any> = {};
  for (const op of ops) {
    const parameters: any[] = [];
    if (op.path.includes('{id}')) {
      parameters.push({ name: 'id', in: 'path', required: true, schema: { type: 'integer' } });
    }
    if (op.path.includes('{provider}')) {
      parameters.push({ name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['google', 'telegram'] } });
    }
    if(op.path.includes('{channel}'))parameters.push({name:'channel',in:'path',required:true,schema:{type:'string',enum:['email','telegram']}});
    if (op.query) {
      const qs = json(op.query, 'input') as any;
      for (const [name, schema] of Object.entries<any>(qs.properties ?? {})) {
        const { description, ...rest } = schema;
        parameters.push({ name, in: 'query', required: false, description, schema: rest });
      }
    }
    (paths[op.path] ??= {})[op.method] = {
      summary: op.summary + (op.admin ? ' (admin only)' : ''),
      ...(op.public && { security: [] }),
      parameters,
      ...(op.body && {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: json(op.body, 'input') } },
        },
      }),
      responses: {
        200: {
          description: 'OK',
          ...(op.response && {
            content: { 'application/json': { schema: json(op.response, 'output') } },
          }),
        },
        default: {
          description: 'Error',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { error: { type: 'string' } } },
            },
          },
        },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'AI Guild',
      version: '0.1.0',
      description:
        'Task and time tracker for AI agents. Agent accounts must send "model" and "effort" on every write.',
    },
    components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } } },
    security: [{ apiKey: [] }],
    paths,
  };
}
