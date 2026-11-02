// The queue above the composer: messages sent while the agent works wait here. Steer hands one to the
// running agent at its next step; the rest run after it, oldest first. Changes arrive as live events.
import { getBridge } from '../bridge/client';
import {copyText} from '../bridge/clipboard';
import { useApp } from '../model/store';
import { describe } from './controller';
import { runPending } from './execution';

const api = () => getBridge()?.service ?? null;
const toast = (text: string, tone: 'info' | 'error' = 'info') => useApp.getState().toast(text, tone);

export async function steerQueued(sessionId: string, instructionId: string): Promise<void> {
  const result = await api()?.steerInstruction(sessionId, instructionId);
  if (result && !result.ok) toast(describe(result.error), 'error');
}

export async function removeQueued(sessionId: string, instructionId: string): Promise<boolean> {
  const result = await api()?.removeInstruction(sessionId, instructionId);
  if (result && !result.ok) { toast(describe(result.error), 'error'); return false; }
  return Boolean(result);
}

/** Takes the message out of the queue and puts its text back in the composer. */
export async function editQueued(sessionId: string, instructionId: string, text: string): Promise<void> {
  if (!(await removeQueued(sessionId, instructionId))) return;
  const app = useApp.getState();
  const current = app.drafts[sessionId]?.text ?? '';
  app.setDraft(sessionId, { text: current.trim() ? `${text}\n\n${current}` : text });
  document.querySelector<HTMLTextAreaElement>('.composer-dock .composer-input')?.focus();
}

/** With the agent idle, the host runs the next queued message now. */
export function runQueued(sessionId: string): void { void runPending(sessionId); }

export async function copyQueued(text: string): Promise<void> {
  try { await copyText(text); toast('Copied.'); } catch { toast('Couldn’t copy the message.', 'error'); }
}
