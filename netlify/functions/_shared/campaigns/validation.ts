import { z } from 'zod'

const uuid = z.string().uuid()
const clean = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(min).max(max))
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().max(254).regex(/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i))
const multiline = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim())
    .pipe(z.string().min(min).max(max))

export const accountActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    organization_id: uuid,
    provider: z.enum(['resend', 'gmail', 'microsoft365']),
    label: clean(2, 80),
    from_name: clean(2, 80),
    from_email: email,
    reply_to: email.nullable().optional(),
    api_key: z.string().trim().min(10).max(200).regex(/^[A-Za-z0-9_\-.]+$/),
    daily_limit: z.number().int().min(1).max(5000).optional(),
  }),
  z.object({ action: z.literal('refresh'), organization_id: uuid, account_id: uuid, request_verification: z.boolean().optional() }),
  z.object({ action: z.literal('webhook_secret'), organization_id: uuid, account_id: uuid, secret: z.string().trim().min(20).max(200) }),
  z.object({ action: z.literal('revoke'), organization_id: uuid, account_id: uuid }),
  z.object({ action: z.literal('limits'), organization_id: uuid, account_id: uuid, daily_limit: z.number().int().min(1).max(5000), per_minute_limit: z.number().int().min(1).max(120) }),
])

export const testSendSchema = z.object({
  organization_id: uuid,
  account_id: uuid,
  to: email,
  subject: clean(1, 150).optional(),
  body: multiline(1, 2000).optional(),
})

export const inboxActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('reply'),
    organization_id: uuid,
    inbound_id: uuid,
    subject: clean(1, 200),
    body: multiline(2, 6000),
    confirm: z.literal(true),
  }),
  z.object({ action: z.literal('analyze'), organization_id: uuid, inbound_id: uuid }),
])

export const contentRequestSchema = z.object({
  organization_id: uuid,
  campaign_id: uuid,
  position: z.number().int().min(0).max(9),
  instructions: multiline(0, 500).optional(),
})
