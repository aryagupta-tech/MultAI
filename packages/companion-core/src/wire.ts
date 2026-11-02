// What the companions read from the service, validated before display. Objects tolerate added fields
// so a newer service does not break an installed app; every field the app uses is checked.
import {z} from 'zod';

const uuid = z.uuid();
const hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const iso = z.string().max(40);
const jwk = z.object({kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string()});

export const errorBody = z.object({error: z.object({code: z.string().max(100), message: z.string().max(500)})});

export const meSchema = z.object({id: uuid, displayName: z.string().max(120), workspaceId: uuid, deviceId: uuid});
export type Me = z.infer<typeof meSchema>;
export const webSessionSchema = z.object({accessToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), expiresIn: z.number().int().positive().max(86_400), deviceId: uuid});
export const tokenBundleSchema = webSessionSchema.extend({refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), deviceSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional()});
export const signInStartSchema = z.object({flowId: uuid, authorizationUrl: z.url(), expiresAt: z.string()});

export const roleSchema = z.enum(['owner', 'collaborator', 'viewer']);
export const sessionSchema = z.object({
  id: uuid, ownerId: uuid, title: z.string().max(200).nullable(), mode: z.enum(['plan', 'build']), status: z.enum(['inactive', 'paused', 'running']),
  runtimeGeneration: z.number().int().positive(), lastSequence: z.number().int().nonnegative(), role: roleSchema, updatedAt: iso,
  capabilities: z.object({submit: z.boolean(), manage: z.boolean(), execute: z.boolean()}),
});
export type Session = z.infer<typeof sessionSchema>;
export const sessionListSchema = z.object({sessions: z.array(sessionSchema).max(100), cursor: uuid.nullable()});
export const participantSchema = z.object({userId: uuid, role: roleSchema, admittedAt: iso});
export const sessionDetailSchema = z.object({session: sessionSchema, participants: z.array(participantSchema).max(100)});

export const eventSchema = z.object({id: uuid, sequence: z.number().int().positive(), type: z.string().max(100), actorId: uuid.nullable(), payload: z.unknown(), createdAt: iso});
export type WireEvent = z.infer<typeof eventSchema>;
export const eventPageSchema = z.object({events: z.array(eventSchema).max(100), cursor: z.number().int().nonnegative()});

const reviewSchema = z.object({reviewerId: z.string(), reviewerName: z.string().max(120), reviewerKind: z.enum(['participant', 'browser']), decision: z.enum(['accept', 'reject']), comment: z.string().max(2000).nullable(), createdAt: iso});
const evidenceSchema = z.object({id: uuid, criterionVersion: z.number().int().positive(), revision: hex64, kind: z.enum(['command', 'manual']), command: z.string().nullable(), exitCode: z.number().int().nullable(), output: z.string().max(8000), timedOut: z.boolean(), canceled: z.boolean(), durationMs: z.number().int().nullable(), createdAt: iso, reviews: z.array(reviewSchema).max(200)});
export const criterionSchema = z.object({id: uuid, text: z.string().max(2000), checkCommand: z.string().nullable(), version: z.number().int().positive(), state: z.enum(['proposed', 'approved', 'withdrawn']), authorName: z.string().max(120), authorKind: z.enum(['participant', 'browser']), status: z.enum(['proposed', 'needs_review', 'passed', 'failed', 'stale']), evidence: evidenceSchema.nullable()});
export type Criterion = z.infer<typeof criterionSchema>;
export const acceptanceSchema = z.object({revision: hex64.nullable(), criteria: z.array(criterionSchema).max(100)});
export type Acceptance = z.infer<typeof acceptanceSchema>;

export const regionSchema = z.object({x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1)}).refine(r => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001);
export type Region = z.infer<typeof regionSchema>;
export const screenshotSchema = z.object({id: uuid, label: z.string().max(200), image: z.string().max(120_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u), createdAt: iso});
export type SharedScreenshot = z.infer<typeof screenshotSchema>;
export const screenshotsSchema = z.object({screenshots: z.array(screenshotSchema).max(5)});

// ---------------------------------------------------------------- Browser review (guests)

export const reviewEventSchema = z.object({sequence: z.number().int().positive(), at: iso, type: z.string().max(60), who: z.string().max(200).nullable(), data: z.record(z.string(), z.unknown())});
export type ReviewEvent = z.infer<typeof reviewEventSchema>;
export const reviewViewSchema = z.discriminatedUnion('status', [
  z.object({status: z.literal('pending')}),
  z.object({status: z.literal('admitted'), reviewer: z.object({id: uuid, name: z.string().max(120), expiresAt: iso}), session: z.object({title: z.string().max(200), working: z.boolean()}),
    events: z.array(reviewEventSchema).max(100), next: z.number().int().nonnegative(), done: z.boolean(), acceptance: acceptanceSchema, screenshots: z.array(screenshotSchema).max(5)}),
]);
export type ReviewView = z.infer<typeof reviewViewSchema>;

// ---------------------------------------------------------------- Owner controller

export const hostStateSchema = z.object({
  v: z.literal(1), host: z.enum(['online', 'asleep', 'signing_out']), runtimeGeneration: z.number().int().positive(),
  run: z.object({status: z.enum(['idle', 'starting', 'running', 'blocked', 'completed', 'failed', 'stopped']), runId: uuid.nullable(), at: z.number().int().nonnegative()}),
  approval: z.object({actionId: uuid, fingerprint: hex64, kind: z.enum(['file_write', 'shell', 'external']), summary: z.string().max(2000), path: z.string().max(1024).nullable(), newFile: z.boolean().nullable(), reason: z.string().max(500), expiresAt: z.number().int().positive(),
    preview: z.array(z.object({pairingId: uuid, ephemeral: jwk, salt: z.string(), iv: z.string(), data: z.string()})).max(5).nullable()}).nullable(),
  access: z.enum(['ask', 'auto', 'full']), model: z.string().max(200).nullable(), locked: z.number().int().min(0),
});
export type HostState = z.infer<typeof hostStateSchema>;
const hostReport = z.object({state: hostStateSchema, ageMs: z.number().int().nonnegative()}).nullable();
export type HostReport = z.infer<typeof hostReport>;

export const pairingClaimSchema = z.object({pairing: z.object({id: uuid, status: z.enum(['awaiting_confirmation', 'active']), verificationCode: z.string().regex(/^\d{3} \d{3}$/u), ownerName: z.string().max(120), hostName: z.string().max(120), sessionCount: z.number().int().positive()})});
export const controllerStatusSchema = z.object({
  serverTime: z.number().int().positive(),
  pairing: z.object({id: uuid, status: z.enum(['awaiting_confirmation', 'active']), deviceName: z.string().max(120).nullable(), expiresAt: iso.nullable(), verificationCode: z.string(), ownerName: z.string().max(120), hostName: z.string().max(120)}),
  sessions: z.array(z.object({id: uuid, title: z.string().max(200), mode: z.enum(['plan', 'build']), status: z.enum(['inactive', 'paused', 'running']), runtimeGeneration: z.number().int().positive(), lastSequence: z.number().int().nonnegative(), updatedAt: iso, host: hostReport})).max(20),
});
export type ControllerStatus = z.infer<typeof controllerStatusSchema>;
const directionSchema = z.object({id: uuid, authorId: uuid, author: z.string().max(60), text: z.string().max(16_000), revision: z.number().int().nonnegative()});
export type Direction = z.infer<typeof directionSchema>;
export const pendingActionSchema = z.object({actionId: uuid, fingerprint: hex64, runGeneration: z.number().int().positive(), kind: z.enum(['file_write', 'shell', 'external']), expiresAt: z.number().int().positive(),
  path: z.string().max(4096).optional(), contentHash: hex64.optional(), newFile: z.boolean().optional(), command: z.string().max(8000).optional()});
export type PendingAction = z.infer<typeof pendingActionSchema>;
export const controlSessionSchema = z.object({
  serverTime: z.number().int().positive(),
  session: z.object({id: uuid, title: z.string().max(200), mode: z.enum(['plan', 'build']), status: z.enum(['inactive', 'paused', 'running']), runtimeGeneration: z.number().int().positive(), lastSequence: z.number().int().nonnegative()}),
  host: hostReport,
  participants: z.array(z.object({userId: uuid, role: roleSchema, label: z.string().max(60)})).max(100),
  queue: z.object({fingerprint: hex64, requiresReview: z.boolean(), pending: z.array(directionSchema).max(100), previousDirection: z.object({id: uuid, author: z.string(), text: z.string()}).optional()}),
  pendingAction: pendingActionSchema.nullable(),
});
export type ControlSession = z.infer<typeof controlSessionSchema>;
export const controlRequestSchema = z.object({id: uuid, sessionId: uuid, kind: z.enum(['start', 'resolve', 'stop', 'steer', 'approve', 'reject']), status: z.enum(['pending', 'delivered', 'accepted', 'rejected', 'expired', 'canceled']),
  code: z.string().max(64).nullable(), message: z.string().max(500).nullable(), createdAt: iso, expiresAt: iso, deliveredAt: iso.nullable(), acknowledgedAt: iso.nullable()});
export type ControlRequest = z.infer<typeof controlRequestSchema>;
export const controlRequestResponse = z.object({request: controlRequestSchema});

export const hostPresenceSchema = z.object({connected: z.boolean(), report: z.object({state: z.object({host: z.enum(['online', 'asleep', 'signing_out']), run: z.object({status: z.string().max(20)}), locked: z.number().int().min(0)}), ageMs: z.number().int().nonnegative()}).nullable()});
export type HostPresence = z.infer<typeof hostPresenceSchema>;
