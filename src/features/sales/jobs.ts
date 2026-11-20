import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { supabase } from '../../lib/supabase'

export type JobState = { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; error: string | null; output: Record<string, unknown> | null }

export type GenerateBody =
  | { task: 'intelligence'; lead_id: string; instructions?: string }
  | { task: 'messages'; lead_id: string; channel: string; instructions?: string }
  | { task: 'proposal'; lead_id: string; variant: string; instructions?: string }
  | { task: 'follow_up_suggestion'; follow_up_task_id: string }

export function startGeneration(orgId: string, body: GenerateBody) {
  return apiFetch<{ job_id: string }>('/api/sales-agent/generate', { method: 'POST', body: { organization_id: orgId, ...body } })
}

/**
 * Segue un job AI leggendo ai_jobs (RLS: solo la propria organizzazione).
 * Chiama onDone una sola volta quando il job termina.
 */
export function useJob(jobId: string | null, onDone?: (job: JobState) => void) {
  const [job, setJob] = useState<JobState | null>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    if (!jobId || !supabase) {
      setJob(null)
      return
    }
    const db = supabase
    let active = true
    let finished = false
    setJob({ id: jobId, status: 'queued', error: null, output: null })
    const tick = async () => {
      const { data } = await db.from('ai_jobs').select('id, status, error, output').eq('id', jobId).maybeSingle()
      if (!active || !data) return
      const j = data as unknown as JobState
      setJob(j)
      if (!finished && (j.status === 'succeeded' || j.status === 'failed' || j.status === 'cancelled')) {
        finished = true
        clearInterval(timer)
        doneRef.current?.(j)
      }
    }
    const timer = setInterval(() => void tick(), 2000)
    void tick()
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [jobId])

  const running = !!job && (job.status === 'queued' || job.status === 'running')
  return { job, running }
}
