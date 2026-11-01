// Dialogs the composer's commands open: undo the last run, manage skills, and the shortcut help.
// Plus the "Open in editor" menu items shared by the branch chip and the Changes panel.
import { useEffect, useState } from 'react';
import { Code2, FolderOpen, History, Pencil, Plus, Trash2, WandSparkles } from 'lucide-react';
import type { Editor } from '../bridge/execution';
import { COMMANDS } from '../model/commands';
import { deleteSkill, loadEditors, loadSkills, openIn, saveSkill, skillsFor, undo, useAssist } from '../live/assist';
import { Button, Dialog, IconButton, Kbd, type MenuItem } from '../ui/primitives';

const EDITOR_LABELS: Record<Editor, string> = { vscode: 'Open in VS Code', cursor: 'Open in Cursor', zed: 'Open in Zed', finder: 'Show in Finder' };

/** Menu items for the editors installed on this computer. */
export function useEditorItems({ sessionId }: { sessionId: string }): MenuItem[] {
  const editors = useAssist((s) => s.editors);
  useEffect(() => { void loadEditors(); }, []);
  return (editors ?? []).map((editor) => ({ id: `open-${editor}`, label: EDITOR_LABELS[editor], icon: editor === 'finder' ? FolderOpen : Code2, onSelect: () => void openIn(sessionId, editor) }));
}

const close = () => useAssist.setState({ dialog: null });

export function AssistDialogs() {
  const dialog = useAssist((s) => s.dialog);
  return (
    <>
      <UndoDialog />
      {dialog?.kind === 'skills' && <SkillsDialog sessionId={dialog.sessionId} projectId={dialog.projectId} />}
      <Dialog open={dialog?.kind === 'help'} onClose={close} title="Shortcuts and commands" width={560}>
        <div className="dialog-body">
          <ul className="help-list">
            <li><Kbd keys="@" /><span>Point the agent at a file or folder. Its current contents go with your instruction.</span></li>
            <li><Kbd keys="/" /><span>Commands, your skills and saved prompts. Type to filter.</span></li>
            <li><Kbd keys="!" /><span>Run the rest as a command in this chat’s terminal, like <code>!npm test</code>.</span></li>
            <li><Kbd keys="Esc" /><span>Close the suggestion list.</span></li>
          </ul>
          <ul className="help-commands">
            {COMMANDS.map((command) => <li key={command.name}><code>/{command.name}{command.args ? ` [${command.args}]` : ''}</code><span>{command.description}</span></li>)}
          </ul>
          <div className="form-actions"><Button variant="primary" onClick={close}>Done</Button></div>
        </div>
      </Dialog>
    </>
  );
}

function UndoDialog() {
  const dialog = useAssist((s) => s.dialog);
  const [busy, setBusy] = useState(false);
  const preview = dialog?.kind === 'undo' ? dialog : null;
  const files = preview?.preview.files ?? [];
  return (
    <Dialog open={Boolean(preview)} onClose={close} title="Undo the last run?" width={520}
      description={preview ? <>Puts these files back the way they were before the run that started {new Date(preview.preview.checkpoint.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{preview.preview.checkpoint.instruction ? <> for “{preview.preview.checkpoint.instruction.replace(/[.!?…]+$/u, '')}”</> : ''}. Only the session’s worktree changes; the conversation stays.</> : undefined}>
      <div className="dialog-body">
        <ul className="undo-files">
          {files.slice(0, 30).map((file) => (
            <li key={file.path}><span className={`undo-status is-${file.status}`}>{file.status === 'added' ? 'remove' : file.status === 'deleted' ? 'restore' : 'revert'}</span><span className="mono truncate">{file.path}</span></li>
          ))}
          {files.length > 30 && <li className="field-help">and {files.length - 30} more</li>}
        </ul>
        <div className="form-actions">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="danger" icon={History} disabled={busy} onClick={() => {
            if (!preview) return;
            setBusy(true);
            void undo(preview.sessionId).then((ok) => { if (ok) close(); }).finally(() => setBusy(false));
          }}>Undo {files.length} file{files.length === 1 ? '' : 's'}</Button>
        </div>
      </div>
    </Dialog>
  );
}

function SkillsDialog({ sessionId, projectId }: { sessionId: string | null; projectId: string | null }) {
  const skills = useAssist((s) => skillsFor(s, sessionId, projectId));
  const [editing, setEditing] = useState<{ name: string; description: string; body: string; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const scope = { sessionId, projectId };
  useEffect(() => { void loadSkills(sessionId, projectId); }, [sessionId, projectId]);
  const project = (skills ?? []).filter((skill) => skill.source === 'project');
  const personal = (skills ?? []).filter((skill) => skill.source === 'personal');
  return (
    <Dialog open onClose={close} title={editing ? (editing.isNew ? 'New skill' : `Edit /${editing.name}`) : 'Skills'} width={600}
      description={editing ? 'A skill is a set of instructions the agent loads when a request matches its description, or when you type /name.' : 'Reusable instructions for the agent. It sees each skill’s name and description and loads the full instructions when it needs them. Type /name to use one directly.'}>
      {editing ? (
        <form className="dialog-body" onSubmit={(e) => {
          e.preventDefault(); setBusy(true);
          void saveSkill(editing, scope).then((ok) => { if (ok) setEditing(null); }).finally(() => setBusy(false));
        }}>
          <label className="field">
            <span className="field-label">Name</span>
            <input value={editing.name} disabled={!editing.isNew} maxLength={48} placeholder="release-notes" onChange={(e) => setEditing({ ...editing, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/gu, '-') })} />
            <span className="field-help">Lowercase letters, numbers and dashes. You’ll use it as /{editing.name || 'name'}.</span>
          </label>
          <label className="field">
            <span className="field-label">When to use it</span>
            <input value={editing.description} maxLength={300} placeholder="Draft release notes from the commits since the last tag" onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Instructions</span>
            <textarea rows={10} className="mono" value={editing.body} maxLength={30_000} placeholder={'1. Run git log since the last tag.\n2. Group the changes as Added, Fixed and Changed.\n3. Write them to CHANGELOG.md.'} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          </label>
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setEditing(null)}>Back</Button>
            <Button variant="primary" type="submit" disabled={busy || !editing.name || !editing.body.trim()}>Save skill</Button>
          </div>
        </form>
      ) : (
        <div className="dialog-body">
          <SkillGroup title="This project" empty="Add skills to the repository as .multai/skills/<name>/SKILL.md (or .claude/skills) so everyone working on it gets them." skills={project} />
          <SkillGroup title="Your skills" empty="Skills you create here work in every project on this computer." skills={personal}
            onEdit={(skill) => setEditing({ ...skill, isNew: false })}
            onDelete={(name) => void deleteSkill(name, scope)} />
          <div className="form-actions">
            <Button icon={Plus} onClick={() => setEditing({ name: '', description: '', body: '', isNew: true })}>New skill</Button>
            <span className="spacer" />
            <Button variant="primary" onClick={close}>Done</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function SkillGroup({ title, empty, skills, onEdit, onDelete }: {
  title: string; empty: string;
  skills: { name: string; description: string; body: string }[];
  onEdit?: (skill: { name: string; description: string; body: string }) => void;
  onDelete?: (name: string) => void;
}) {
  return (
    <section className="skill-group">
      <h3 className="skill-group-title">{title}</h3>
      {skills.length === 0 ? <p className="field-help">{empty}</p> : (
        <ul className="prompt-list">
          {skills.map((skill) => (
            <li key={skill.name}>
              <WandSparkles size={14} aria-hidden className="tone-muted" />
              <div className="prompt-item">
                <strong className="mono">/{skill.name}</strong>
                <span className="field-help prompt-text">{skill.description}</span>
              </div>
              {onEdit && <IconButton size="sm" icon={Pencil} label={`Edit /${skill.name}`} onClick={() => onEdit(skill)} />}
              {onDelete && <IconButton size="sm" icon={Trash2} label={`Delete /${skill.name}`} onClick={() => onDelete(skill.name)} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
