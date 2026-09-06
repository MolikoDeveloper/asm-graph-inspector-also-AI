import { Boxes, FileCode2, GitBranch, Search, Settings } from 'lucide-react';
import type { WorkspaceState } from '../features/workspace/model';

export function ActivityBar({ active, onActivity, onSettings }: { active: WorkspaceState['activeActivity']; onActivity(activity: WorkspaceState['activeActivity']): void; onSettings(): void }) {
  const items = [
    ['explorer', FileCode2, 'Explorer'],
    ['search', Search, 'Search'],
    ['analysis', GitBranch, 'Analysis']
  ] as const;
  return (
    <aside className="activity-bar">
      <div className="activity-top"><div className="activity-logo"><Boxes size={19} /></div>
        {items.map(([id, Icon, label]) => <button key={id} className={active === id ? 'active' : ''} aria-label={label} title={label} onClick={() => onActivity(id)}><Icon size={19} /></button>)}
      </div>
      <button aria-label="Settings" title="Settings" onClick={onSettings}><Settings size={19} /></button>
    </aside>
  );
}
