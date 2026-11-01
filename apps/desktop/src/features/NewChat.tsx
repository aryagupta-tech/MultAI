import { useEffect, useState } from 'react';
import { Folder, GitBranch, Laptop, Users } from 'lucide-react';
import { useApp } from '../model/store';
import { Composer } from './Composer';
import { Segmented } from '../ui/primitives';
import { getBridge } from '../bridge/client';
import { useWork } from '../live/work';



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

        <Composer d={null} draftKey="new" autoFocus />

        {dataMode === 'live' && (
          <p className="new-chat-fine">
            <button type="button" className="link-btn" onClick={() => app.openOverlay('join')}><Users size={12} aria-hidden /> Have an invitation?</button>
          </p>
        )}
      </div>
    </div>
  );
}
