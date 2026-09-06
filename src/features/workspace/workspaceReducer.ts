import type { WorkspaceState } from './model';
import { makeId } from '../../shared/id';

export type WorkspaceAction =
  | { type: 'open-file'; fileId: string; groupId?: string }
  | { type: 'close-tab'; fileId: string; groupId: string }
  | { type: 'activate-file'; fileId: string; groupId: string }
  | { type: 'activate-group'; groupId: string }
  | { type: 'split-right' }
  | { type: 'close-group'; groupId: string }
  | { type: 'toggle-explorer' }
  | { type: 'toggle-graph' }
  | { type: 'toggle-bottom' }
  | { type: 'set-activity'; activity: WorkspaceState['activeActivity'] }
  | { type: 'reset' };

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'open-file': {
      const targetId = action.groupId ?? state.activeGroupId;
      return {
        ...state,
        activeGroupId: targetId,
        groups: state.groups.map((group) => {
          if (group.id !== targetId) return group;
          const tabs = group.tabs.includes(action.fileId) ? group.tabs : [...group.tabs, action.fileId];
          return { ...group, tabs, activeFileId: action.fileId };
        })
      };
    }
    case 'close-tab': {
      return {
        ...state,
        groups: state.groups.map((group) => {
          if (group.id !== action.groupId) return group;
          const index = group.tabs.indexOf(action.fileId);
          const tabs = group.tabs.filter((id) => id !== action.fileId);
          let activeFileId = group.activeFileId;
          if (activeFileId === action.fileId) {
            activeFileId = tabs[Math.max(0, index - 1)] ?? tabs[0] ?? null;
          }
          return { ...group, tabs, activeFileId };
        })
      };
    }
    case 'activate-file':
      return {
        ...state,
        activeGroupId: action.groupId,
        groups: state.groups.map((group) => group.id === action.groupId ? { ...group, activeFileId: action.fileId } : group)
      };
    case 'activate-group':
      return { ...state, activeGroupId: action.groupId };
    case 'split-right': {
      const source = state.groups.find((group) => group.id === state.activeGroupId) ?? state.groups[0];
      if (state.groups.length >= 3) return state;
      const newGroup = {
        id: makeId('group'),
        tabs: source.activeFileId ? [source.activeFileId] : [],
        activeFileId: source.activeFileId
      };
      return { ...state, groups: [...state.groups, newGroup], activeGroupId: newGroup.id };
    }
    case 'close-group': {
      if (state.groups.length === 1) return state;
      const groups = state.groups.filter((group) => group.id !== action.groupId);
      return { ...state, groups, activeGroupId: groups[0].id };
    }
    case 'toggle-explorer':
      return { ...state, explorerVisible: !state.explorerVisible };
    case 'toggle-graph':
      return { ...state, graphVisible: !state.graphVisible };
    case 'toggle-bottom':
      return { ...state, bottomPanelVisible: !state.bottomPanelVisible };
    case 'set-activity':
      return { ...state, activeActivity: action.activity, explorerVisible: true };
    case 'reset':
      return {
        ...state,
        groups: [{ id: 'group-main', tabs: [], activeFileId: null }],
        activeGroupId: 'group-main'
      };
  }
}
