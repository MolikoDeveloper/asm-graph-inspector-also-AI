import { ChevronRight, GitBranch, Minus, Plus } from 'lucide-react';
import type { ProgramFlowGroup, ProgramFlowScope } from '../features/analysis/programFlow';

export function ProgramFlowToolbar({
  groups,
  hiddenGroups,
  expandedGroups,
  scope,
  visitedCount,
  activeName,
  onScopeChange,
  onToggleVisibility,
  onShowAll,
  onHideAll,
  onCompactAll
}: {
  groups: ProgramFlowGroup[];
  hiddenGroups: Set<string>;
  expandedGroups: Set<string>;
  scope: ProgramFlowScope;
  visitedCount: number;
  activeName: string;
  onScopeChange(scope: ProgramFlowScope): void;
  onToggleVisibility(groupId: string): void;
  onShowAll(): void;
  onHideAll(): void;
  onCompactAll(): void;
}) {
  return (
    <div className="program-flow-toolbar">
      <div className="program-flow-toolbar-main">
        <label>
          <GitBranch size={13} />
          <span>Scope</span>
          <select value={scope} onChange={(event) => onScopeChange(event.currentTarget.value as ProgramFlowScope)}>
            <option value="focus">Focus</option>
            <option value="visited">Connected calls</option>
            <option value="all">All groups</option>
          </select>
        </label>
        <span className="program-flow-visited">{visitedCount} inspected</span>
        <span className="program-flow-active" title={activeName}>Focus: {activeName}</span>
        <button type="button" onClick={onShowAll}><Plus size={12} />Show all</button>
        <button type="button" onClick={onHideAll}><Minus size={12} />Hide all</button>
        <button type="button" onClick={onCompactAll}><ChevronRight size={12} />Compact all</button>
        <span className="program-flow-interaction-hint">Click = inspect · Double-click = open / expand</span>
      </div>
      <div className="program-flow-groups" aria-label="Program flow group filters">
        {groups.map((group) => {
          const hidden = hiddenGroups.has(group.id);
          const expanded = expandedGroups.has(group.id);
          return (
            <button
              key={group.id}
              type="button"
              className={`${hidden ? 'hidden' : ''} ${expanded ? 'expanded' : ''}`}
              onClick={() => onToggleVisibility(group.id)}
              title={`${hidden ? 'Show' : 'Hide'} ${group.label}`}
            >
              <span>{group.label}</span>
              <small>{group.count}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
