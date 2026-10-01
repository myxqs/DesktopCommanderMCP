import { z } from 'zod';

export const NATIVE_RDC_PROTOCOL_VERSION = 1;

const IsoDateTime = z.string().datetime();
const Id = z.string().min(1).max(128);
const DeviceId = z.string().min(1).max(128);
const ToolName = z.string().min(1).max(256);

export const ToolDescriptorSchema = z.object({
  name: ToolName,
}).passthrough();

export const DeviceHelloSchema = z.object({
  type: z.literal('DEVICE_HELLO'),
  protocol_version: z.literal(NATIVE_RDC_PROTOCOL_VERSION),
  device_id: DeviceId,
  device_name: z.string().min(1).max(256),
  sent_at: IsoDateTime,
}).strict();

export const DeviceReadySchema = z.object({
  type: z.literal('DEVICE_READY'),
  protocol_version: z.literal(NATIVE_RDC_PROTOCOL_VERSION),
  device_id: DeviceId,
  accepted: z.boolean(),
  relay_id: Id,
  sent_at: IsoDateTime,
}).strict();
export const HeartbeatSchema = z.object({
  type: z.literal('HEARTBEAT'),
  device_id: DeviceId,
  sent_at: IsoDateTime,
}).strict();

export const ToolListSchema = z.object({
  type: z.literal('TOOL_LIST'),
  device_id: DeviceId,
  tools: z.array(ToolDescriptorSchema).max(1000),
  sent_at: IsoDateTime,
}).strict();

export const ToolCallSchema = z.object({
  type: z.literal('TOOL_CALL'),
  call_id: Id,
  device_id: DeviceId,
  tool_name: ToolName,
  arguments: z.record(z.unknown()),
  created_at: IsoDateTime,
  deadline_at: IsoDateTime,
}).strict();

export const CallAckSchema = z.object({
  type: z.literal('CALL_ACK'),
  call_id: Id,
  device_id: DeviceId,
  acknowledged_at: IsoDateTime,
}).strict();
export const ToolResultSchema = z.object({
  type: z.literal('TOOL_RESULT'),
  call_id: Id,
  device_id: DeviceId,
  status: z.literal('completed'),
  result: z.unknown(),
  completed_at: IsoDateTime,
}).strict();

export const ToolErrorSchema = z.object({
  type: z.literal('TOOL_ERROR'),
  call_id: Id,
  device_id: DeviceId,
  status: z.literal('failed'),
  error: z.object({
    message: z.string().min(1).max(4096),
    code: z.string().min(1).max(128).optional(),
  }).strict(),
  completed_at: IsoDateTime,
}).strict();

export const DeviceOfflineSchema = z.object({
  type: z.literal('DEVICE_OFFLINE'),
  device_id: DeviceId,
  reason: z.string().max(512).optional(),
  sent_at: IsoDateTime,
}).strict();

export const DeviceInboundMessageSchema = z.discriminatedUnion('type', [
  DeviceHelloSchema,
  HeartbeatSchema,
  ToolListSchema,
  CallAckSchema,
  ToolResultSchema,
  ToolErrorSchema,
  DeviceOfflineSchema,
]);

export type DeviceHello = z.infer<typeof DeviceHelloSchema>;
export type DeviceReady = z.infer<typeof DeviceReadySchema>;
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
export type ToolList = z.infer<typeof ToolListSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type CallAck = z.infer<typeof CallAckSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type ToolError = z.infer<typeof ToolErrorSchema>;
export type DeviceOffline = z.infer<typeof DeviceOfflineSchema>;
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;
export type TerminalToolMessage = ToolResult | ToolError;

export const terminalMessageSchema = z.union([ToolResultSchema, ToolErrorSchema]);
