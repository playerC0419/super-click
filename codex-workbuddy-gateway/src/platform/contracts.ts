import { z } from "zod";

export const requestSchema = z.object({
  provider: z.string().min(1).max(80).default("workbuddy"),
  task: z.string().trim().min(1).max(100_000),
  workspace: z.string().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  output: z.enum(["text", "json", "artifacts"]).default("text"),
  idempotencyKey: z.string().min(1).max(200).optional(),
  constraints: z.array(z.string().min(1).max(4000)).max(100).default([]),
  timeoutSeconds: z.number().int().min(10).max(86_400).default(1800),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).max(30).optional(),
  attachmentIds: z.array(z.string().uuid()).max(20).optional(),
  priority: z.number().int().min(-10).max(10).optional(),
}).strict();
export type RunInput = z.infer<typeof requestSchema>;
export type RunRequestInput = z.input<typeof requestSchema>;
export type RunStatus = "queued" | "dispatching" | "submitted" | "running" | "completed" | "blocked" | "failed" | "cancel_requested" | "cancelled" | "uncertain";
export interface Artifact { path: string; name: string; bytes: number; snapshotPath?:string; sha256?:string; capturedAt?:string; }
export interface ReviewCheck { id:string; label:string; status:"pending"|"passed"|"failed"; evidence:string; round:number; }
export interface TaskAttachment { id:string; name:string; path:string; bytes:number; sha256:string; }
export interface TaskMessage { id:string; text:string; attachments:TaskAttachment[]; createdAt:string; attemptId?:string; targetRound?:number; delivery:"queued"|"delivered"; deliveredAt?:string; }
export interface WaitingInput { id:string; question:string; kind:"question"|"materials"; createdAt:string; }
export interface RoundRecord { round:number; resultFile:string; feedback?:string; result?:HubRun["result"]; checks?:ReviewCheck[]; finishedAt?:string; }
export interface HubRun {
  id: string; input: RunInput; workspace: string; providerTaskId: string;
  status: RunStatus; review: "pending" | "accepted"; holdsCapacity: boolean;
  round: number; resultFile: string; previousAttemptId?: string; feedback?: string;
  attemptId?: string; sessionId?: string; runtimeSource?: string;
  result?: { text: string; json?: unknown; artifacts: Artifact[] };
  error?: { code: string; message: string }; lastPollError?: string;
  usage: { credits: null; source: "unavailable" };
  createdAt: string; updatedAt: string; deadline: string;
  archived?:boolean; priority?:number; checks?:ReviewCheck[]; history?:RoundRecord[];
  attachments?:TaskAttachment[]; messages?:TaskMessage[]; waitingInput?:WaitingInput;
  startedAt?:string; finishedAt?:string; progressSummary?:string; lastActivityAt?:string; retryCount?:number;
}
export interface HubEvent { id: number; runId: string; type: string; data: unknown; createdAt: string; }
export interface ProviderEvent { key: string; type: string; text: string; }
export interface ProviderSnapshot {
  status: "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";
  holdsCapacity: boolean; attemptId?: string; sessionId?: string; runtimeSource?: string;
  error?: string; accepted?: boolean; events: ProviderEvent[];
  waitingInput?:WaitingInput; deliveredMessages?:Array<{id:string;deliveredAt:string}>; progressSummary?:string; lastActivityAt?:string;
}
export interface AgentProvider {
  readonly id: string; readonly label: string;
  readonly capabilities: Record<string, unknown>;
  health(): Promise<{ state: string; message: string; usage: HubRun["usage"]; [key: string]: unknown }>;
  submit(run: HubRun, signal?: AbortSignal): Promise<void>;
  poll(run: HubRun): Promise<ProviderSnapshot | undefined>;
  cancel(run: HubRun): Promise<void>;
  rework(run: HubRun, signal?: AbortSignal): Promise<void>;
  accept(run: HubRun, input: { note: string; evidence: string[] }): Promise<void>;
  models?(sessionId?:string):Promise<unknown>;
  workspaces?():unknown;
  bindWorkspace?(input:{workspace:string;sessionId?:string;model?:string;title?:string}):Promise<unknown>;
  canRetry?(run:HubRun):Promise<boolean>;
  deliver?(run:HubRun,message:TaskMessage):Promise<void>;
  recover?(run:HubRun,reason:string):Promise<void>;
}
export class HubError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 400) { super(message); }
}
export const waitingStates = new Set<RunStatus>(["queued", "dispatching", "submitted", "running"]);
