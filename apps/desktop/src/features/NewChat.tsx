import { useEffect, useState } from 'react';
import { Bug, FileSearch, Folder, GitBranch, Laptop, Lightbulb, ListChecks, MessagesSquare, TestTube2, Users } from 'lucide-react';
import { useApp } from '../model/store';
import type { MessageKind } from '../model/types';
import { Composer } from './Composer';
import { Segmented } from '../ui/primitives';
import { getBridge } from '../bridge/client';
import { useWork } from '../live/work';

const CHIPS = [
  { icon: Bug, title: 'Fix a bug', text: 'There’s a bug where ', kind: 'instruction' },
  { icon: TestTube2, title: 'Add tests', text: 'Add tests for ', kind: 'instruction' },
  { icon: FileSearch, title: 'Explain code', text: 'Explain how this works: ', kind: 'instruction' },
] as const;

const CARDS = [
  {
    icon: ListChecks, title: 'Plan a feature', tag: 'Plan mode',
    desc: 'Agree on the approach as a team before any file changes.',
    text: 'Help us plan a feature that ', kind: 'instruction',
  },
  {
    icon: Lightbulb, title: 'Review an idea', tag: 'Agent',
    desc: 'Get trade-offs, risks and a smallest-first path.',
    text: 'Review this idea and list the trade-offs: ', kind: 'instruction',
  },
  {
    icon: MessagesSquare, title: 'Start a discussion', tag: 'Team',
    desc: 'Talk with teammates first. The agent won’t act on it.',
    text: '', kind: 'discussion',
  },
] as const;

export function NewChat() {
  const projectId = useApp((s) => s.draftTarget.projectId);
  const project = useApp((s) => s.projects.find((p) => p.id === projectId));
  const dataMode = useApp((s) => s.dataMode);
  const app = useApp.getState();
  const carry = useWork((s) => s.carry);
  const legacy = Boolean(project?.id.startsWith('p-'));
  const [git, setGit] = useState(project?.git);
  // Refresh the branch and uncommitted count; they change while the app is open.
  useEffect(() => {
    setGit(project?.git);
    if (!project || legacy || dataMode !== 'live') return;
    let current = true;
    void getBridge()?.inference.projectStatus(project.id).then((r) => { if (current && r.ok) setGit(r.value); });
    return () => { current = false; };
  }, [project?.id, legacy, dataMode]);

  const insert = (text: string, kind: MessageKind) => {
    app.setDraft('new', { text, kind });
    window.dispatchEvent(new Event('multai:focus-composer'));
  };

  return (
    <div className="new-chat">
      <div className="new-chat-inner">
        <div className="new-chat-hero">
          <h1>Ready to build something together?</h1>
          <p className="new-chat-where">
            {project
              ? <><Folder size={13} aria-hidden /> {project.name} · {legacy ? 'add this folder again to let the agent work on it' : <>its own branch from <GitBranch size={12} aria-hidden /> {git?.branch ?? 'HEAD'}</>}</>
              : <><Laptop size={13} aria-hidden /> Runs on this computer in a private empty workspace</>}
          </p>
          {project && !legacy && (git?.dirty ?? 0) > 0 && (
            <div className="start-from" role="group" aria-label="Start from">
              <Segmented
                label="Start from"
                size="sm"
                value={carry ? 'mine' : 'commit'}
                onChange={(v) => useWork.setState({ carry: v === 'mine' })}
                options={[
                  { value: 'mine', label: `My ${git!.dirty} uncommitted change${git!.dirty === 1 ? '' : 's'}`, hint: 'The agent starts from exactly what you see. Your folder isn’t changed.' },
                  { value: 'commit', label: 'Last commit', hint: 'The agent starts from the last commit and ignores your uncommitted work.' },
                ]}
              />
            </div>
          )}
        </div>

        <div className="chips" role="group" aria-label="Quick starts">
          {CHIPS.map((c) => {
            const Icon = c.icon;
            return (
              <button key={c.title} type="button" className="chip" onClick={() => insert(c.text, c.kind)}>
                {c.title}
                <Icon size={13} strokeWidth={1.8} aria-hidden />
              </button>
            );
          })}
        </div>

        <Composer d={null} draftKey="new" autoFocus />

        <div className="feature-cards">
          {CARDS.map((c) => {
            const Icon = c.icon;
            return (
              <button key={c.title} type="button" className="feature-card" onClick={() => insert(c.text, c.kind)}>
                <span className="feature-top">
                  <span className="feature-icon"><Icon size={15} strokeWidth={1.8} aria-hidden /></span>
                  <span className="feature-tag">{c.tag}</span>
                </span>
                <span className="feature-title">{c.title}</span>
                <span className="feature-desc">{c.desc}</span>
              </button>
            );
          })}
        </div>

        <p className="new-chat-fine">
          Nothing starts until you send. The session becomes shareable once it exists.
          {dataMode === 'live' && <> <button type="button" className="link-btn" onClick={() => app.openOverlay('join')}><Users size={12} aria-hidden /> Have an invitation?</button></>}
        </p>
      </div>
    </div>
  );
}
