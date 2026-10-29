import { Bug, FileSearch, Folder, Laptop, Lightbulb, TestTube2 } from 'lucide-react';
import { useApp } from '../model/store';
import { Composer } from './Composer';
import { LogoMark } from '../ui/Logo';

const STARTERS = [
  { icon: Bug, title: 'Fix a bug', text: 'There’s a bug where ' },
  { icon: TestTube2, title: 'Add tests', text: 'Add tests for ' },
  { icon: FileSearch, title: 'Explain code', text: 'Explain how this works: ' },
  { icon: Lightbulb, title: 'Plan a feature', text: 'Help me plan a feature that ' },
];

export function NewChat() {
  const projectId = useApp((s) => s.draftTarget.projectId);
  const project = useApp((s) => s.projects.find((p) => p.id === projectId));
  const draft = useApp((s) => s.drafts.new);
  const dataMode = useApp((s) => s.dataMode);
  const app = useApp.getState();

  return (
    <div className="new-chat">
      <div className="new-chat-inner">
        <div className="new-chat-hero">
          <LogoMark size={36} />
          <h1>What are we working on?</h1>
          <p className="new-chat-where">
            {project ? <><Folder size={13} aria-hidden /> {project.name} · new worktree from the latest commit</> : <><Laptop size={13} aria-hidden /> Runs on this computer in a private empty workspace</>}
          </p>
        </div>
        <Composer d={null} draftKey="new" autoFocus />
        {!draft?.text && (
          <div className="starters">
            {STARTERS.map((s) => {
              const Icon = s.icon;
              return (
                <button key={s.title} type="button" className="starter" onClick={() => {
                  app.setDraft('new', { text: s.text, kind: 'instruction' });
                  window.dispatchEvent(new Event('multai:focus-composer'));
                }}>
                  <Icon size={15} strokeWidth={1.8} aria-hidden />
                  {s.title}
                </button>
              );
            })}
          </div>
        )}
        <p className="new-chat-fine">
          Nothing starts until you send. The session becomes shareable once it exists.
          {dataMode === 'live' && <> <button type="button" className="link-btn" onClick={() => app.openOverlay('join')}>Have an invitation?</button></>}
        </p>
      </div>
    </div>
  );
}
