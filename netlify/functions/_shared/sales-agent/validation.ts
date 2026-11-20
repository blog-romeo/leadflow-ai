import { z } from 'zod'

const uuid = z.string().uuid()
const instructions = z
  .string()
  .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
  .pipe(z.string().max(500))
  .optional()

/** Input dell'endpoint /api/sales-agent/generate (validazione lato server). */
export const generateInputSchema = z.discriminatedUnion('task', [
  z.object({ organization_id: uuid, task: z.literal('intelligence'), lead_id: uuid, instructions }),
  z.object({ organization_id: uuid, task: z.literal('messages'), lead_id: uuid, channel: z.enum(['email', 'linkedin', 'whatsapp', 'phone_script', 'follow_up']), instructions }),
  z.object({ organization_id: uuid, task: z.literal('proposal'), lead_id: uuid, variant: z.enum(['professional', 'direct', 'consultative']), instructions }),
  z.object({ organization_id: uuid, task: z.literal('follow_up_suggestion'), follow_up_task_id: uuid }),
])

export const copilotInputSchema = z.object({
  organization_id: uuid,
  conversation_id: uuid.optional(),
  lead_id: uuid.optional(),
  message: z
    .string()
    .transform((s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim())
    .pipe(z.string().min(2).max(1000)),
})
