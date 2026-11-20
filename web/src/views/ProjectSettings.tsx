import { useEffect, useState } from 'react';
import type { Project } from '../lib/types.ts';
import { Modal, Button, Field, confirmDialog, toastError, toast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { loadProjects } from '../lib/store.ts';

const COLORS = ['#d4f25a', '#7ce0c3', '#f2a65a', '#9fb4ff', '#f27a9b', '#c9a7ff', '#5ad1f2', '#ecebe4'];

export function ProjectSettings({ open, onClose, project }: { open: boolean; onClose: () => void; project: Project }) {
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(project.color);
  useEffect(() => {
    if (open) {
      setName(project.name);
      setColor(project.color);
    }
  }, [open, project]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.patch(`/projects/${project.id}`, { name, color });
      toast({ title: 'Project updated', tone: 'ok' });
      onClose();
    } catch (err) {
      toastError(err);
    }
  };

  const del = async () => {
    const ok = await confirmDialog({
      title: `Delete ${project.name}?`,
      body: 'Every service, container, image and volume in this project will be removed. This cannot be undone.',
      confirm: 'Delete project',
      danger: true,
      typeToConfirm: project.slug,
    });
    if (!ok) return;
    try {
      onClose();
      navigate('/', { replace: true });
      await api.del(`/projects/${project.id}`);
      await loadProjects();
      toast({ title: 'Project deleted', tone: 'idle' });
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={460}>
      <form onSubmit={save} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h2 className="h2">Project settings</h2>
        <Field label="Name">
          <input className="input input-lg" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Color">
          <div className="row" style={{ gap: 8 }}>
            {COLORS.map((c) => (
              <button type="button" key={c} className={`color-swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
          </div>
        </Field>
        <div className="row">
          <Button type="button" variant="danger" icon="trash" onClick={() => void del()}>
            Delete project
          </Button>
          <div className="spacer" />
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
