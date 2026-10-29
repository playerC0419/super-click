import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentHubClient } from "./client.js";
import { requestSchema } from "./contracts.js";
import { loadDotEnv } from "../env.js";

loadDotEnv();

const server = new McpServer({ name: "agent-hub", version: "0.7.0" });
const id = z.string().min(1);
const guard = async (fn: (client: AgentHubClient) => Promise<unknown>) => {
  try { return { content: [{ type: "text" as const, text: JSON.stringify(await fn(AgentHubClient.local())) }] }; }
  catch (error) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }] }; }
};
server.tool("agent_hub_providers", "List implemented executors, capabilities and actual availability. Unknown credits are not zero credits.", {}, () => guard(client => client.request("/v1/providers")));
server.tool("agent_hub_models", "List the native WorkBuddy model IDs available now, optionally read a session's current selection.", {sessionId:z.string().min(1).optional()}, ({sessionId})=>guard(client=>client.request('/v1/providers/workbuddy/models'+(sessionId?'?sessionId='+encodeURIComponent(sessionId):''))));
server.tool("agent_hub_workspaces", "List project bindings. Old queued tasks and rework retain their original session.", {}, ()=>guard(client=>client.request('/v1/providers/workbuddy/workspaces')));
server.tool("agent_hub_bind_workspace", "Create/reuse or switch a project's native session binding. Optional model changes an idle session without queued tasks. Use native model IDs from agent_hub_models.", {workspace:z.string().min(1),sessionId:z.string().min(1).optional(),model:z.string().trim().min(1).optional(),title:z.string().min(1).max(200).optional()}, input=>guard(client=>client.request('/v1/providers/workbuddy/workspaces','POST',input)));
server.tool("agent_hub_submit", "Submit a durable task. Use a stable idempotencyKey. Workspace omitted means an isolated directory. Queue acceptance is not completion. No automatic fallback to another executor.", requestSchema.shape, input => guard(client => client.submit(input)));
server.tool("agent_hub_get", "Read run status, executor provenance, validated output and independent review status.", { id }, ({ id }) => guard(client => client.get(id)));
server.tool("agent_hub_list", "List recent platform runs.", { limit: z.number().int().min(1).max(100).default(20) }, ({ limit }) => guard(client => client.request(`/v1/runs?limit=${limit}`)));
server.tool("agent_hub_wait", "Wait up to 50 seconds without model polling. Blocked/uncertain states need attention; completion does not imply independent acceptance.", { id, seconds: z.number().int().min(1).max(50).default(45) }, ({ id, seconds }) => guard(client => client.request(`/v1/runs/${encodeURIComponent(id)}/wait?timeoutSeconds=${seconds}`)));
server.tool("agent_hub_events", "Read persistent execution events after a cursor; no full native tool trace is promised.", { id, after: z.number().int().nonnegative().default(0) }, ({ id, after }) => guard(client => client.events(id, after)));
server.tool("agent_hub_cancel", "Request cooperative cancellation. cancel_requested does not prove execution stopped.", { id }, ({ id }) => guard(client => client.cancel(id)));
server.tool("agent_hub_rework", "Send specific corrections to a confirmed finished attempt in its original executor session. Optional model selects another native model for the next round.", { id, feedback: z.string().min(1),model:z.string().trim().min(1).optional() }, ({ id, feedback,model }) => guard(client => client.rework(id, feedback,model)));
server.tool("agent_hub_accept", "Record independent review after checking actual content. Output format validation alone is not acceptance evidence.", { id, note: z.string().min(1), evidence: z.array(z.string().min(1)).min(1) }, ({ id, note, evidence }) => guard(client => client.accept(id, note, evidence)));
server.tool("agent_hub_queue", "Read or pause/resume future dispatch. Pausing never interrupts active WorkBuddy.", {paused:z.boolean().optional()}, ({paused})=>guard(client=>client.request('/v1/queue',paused===undefined?'GET':'POST',paused===undefined?undefined:{paused})));
server.tool("agent_hub_reply", "Save supplemental instructions or answer the executor. Saved is not delivered until the current desktop claim consumes it. Resume only a finished round.",{id,text:z.string().max(16000),attachmentIds:z.array(z.string().uuid()).default([]),expectedRound:z.number().int().positive(),resume:z.boolean().optional()},({id,...body})=>guard(client=>client.request(`/v1/runs/${encodeURIComponent(id)}/messages`,'POST',body)));
server.tool("agent_hub_retry", "Retry only a confirmed never-dispatched failed task; uncertain attempts are refused.",{id},({id})=>guard(client=>client.request(`/v1/runs/${encodeURIComponent(id)}/retry`,'POST',{})));
server.tool("agent_hub_checks", "Record actual independent evidence per criterion before accepting. Never invent pass evidence.",{id,expectedRound:z.number().int().positive(),checks:z.array(z.object({id:z.string().min(1),label:z.string().min(1),status:z.enum(['pending','passed','failed']),evidence:z.string(),round:z.number().int().positive()})).max(30)},({id,...body})=>guard(client=>client.request(`/v1/runs/${encodeURIComponent(id)}/checks`,'POST',body)));
server.tool("agent_hub_versions", "Read immutable artifact metadata and results from every saved round.",{id},({id})=>guard(client=>client.request(`/v1/runs/${encodeURIComponent(id)}/versions`)));
server.tool("agent_hub_rework_draft", "Generate an unsent rework draft from failed checks. It does not submit corrections.",{id},({id})=>guard(client=>client.request(`/v1/runs/${encodeURIComponent(id)}/rework-draft`)));
server.tool("agent_hub_task_settings", "Archive terminal tasks or set queued priority; does not delete history.",{id,archived:z.boolean().optional(),priority:z.number().int().min(-10).max(10).optional()},({id,...body})=>guard(client=>client.request(`/v1/runs/${encodeURIComponent(id)}/settings`,'POST',body)));
await server.connect(new StdioServerTransport());
