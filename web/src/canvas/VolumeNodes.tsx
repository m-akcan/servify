import { useEffect, useRef, useState } from 'react';
import type { VolumeGroup } from '../lib/volumes.tsx';
import { Icon } from '../components/Icon.tsx';
import { openMenuAt, openMenu } from '../components/ui.tsx';
import { volumeMenu, bytes, openVolumeDialog } from '../lib/volumes.tsx';
import { api } from '../lib/api.ts';
import { registry, type Camera } from './geometry.ts';

/** The tab docked under a service card for each attached volume. */
export function VolumeTabs({ volumes }: { volumes: VolumeGroup[] }) {
  if (!volumes.length) return null;
  return (
    <div className="vol-tabs">
      {volumes.map((v) => (
        <button
          key={v.id}
          className="vol-tab"
          title={`${v.name} → ${v.mountPath}`}
          onClick={(e) => {
            e.stopPropagation();
            openMenuAt(e.currentTarget, volumeMenu(v));
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu(e.clientX, e.clientY, volumeMenu(v));
          }}
        >
          <Icon name="database" size={12} />
          <span className="vol-tab-name truncate">{v.name}{v.members > 1 ? ` ×${v.members}` : ''}</span>
          <span className="vol-tab-size">{bytes(v.sizeBytes)}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A detached volume, floating on the canvas. Drag it onto a service to attach it (the drop target lights up),
 * or anywhere else to move it.
 */
export function DetachedVolumeNode({
  volume: v,
  getCamera,
  serviceIds,
  onHover,
}: {
  volume: VolumeGroup;
  getCamera: () => Camera;
  serviceIds: Set<string>;
  onHover: (serviceId: string | null) => void;
}) {
  const [pos, setPos] = useState({ x: v.x, y: v.y });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean; over: string | null } | null>(null);
  useEffect(() => {
    if (!drag.current) setPos({ x: v.x, y: v.y });
  }, [v.x, v.y]);

  const hit = (x: number, y: number) => {
    // Centre of the volume card, in world space.
    const cx = x + 90;
    const cy = y + 26;
    for (const [id, r] of registry.rects) if (serviceIds.has(id) && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return id;
    return null;
  };

  return (
    <div
      className={`vol-node ${dragging ? 'dragging' : ''}`}
      style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
        e.stopPropagation();
        drag.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false, over: null };
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {}
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const z = getCamera().z;
        const dx = (e.clientX - d.sx) / z;
        const dy = (e.clientY - d.sy) / z;
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        if (!d.moved) setDragging(true);
        d.moved = true;
        const next = { x: d.ox + dx, y: d.oy + dy };
        setPos(next);
        const over = hit(next.x, next.y);
        if (over !== d.over) {
          d.over = over;
          onHover(over);
        }
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        setDragging(false);
        if (!d?.moved) return;
        onHover(null);
        if (d.over) {
          setPos({ x: d.ox, y: d.oy }); // spring back; the volume docks under the service once attached
          openVolumeDialog({ kind: 'attach', volumeId: v.id, serviceId: d.over, mountPath: v.mountPath });
          return;
        }
        void api.patch(`/volumes/${v.id}`, { x: pos.x, y: pos.y }).catch(() => {});
      }}
      onDoubleClick={() => openVolumeDialog({ kind: 'attach', volumeId: v.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, volumeMenu(v));
      }}
    >
      <div className="vol-node-icon">
        <Icon name="database" size={15} />
      </div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="vol-node-name truncate">{v.name}</div>
        <div className="vol-node-meta">
          detached{v.members > 1 ? ` · ×${v.members}` : ''} · {bytes(v.sizeBytes)}
        </div>
      </div>
      <button className="vol-node-more" onClick={(e) => openMenuAt(e.currentTarget, volumeMenu(v), 'right')} aria-label={`${v.name} actions`}>
        <Icon name="more" size={14} />
      </button>
    </div>
  );
}
