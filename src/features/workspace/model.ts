export interface EditorGroupState {
  id: string;
  tabs: string[];
  activeFileId: string | null;
}

export interface WorkspaceState {
  groups: EditorGroupState[];
  activeGroupId: string;
  explorerVisible: boolean;
  graphVisible: boolean;
  bottomPanelVisible: boolean;
  bottomPanelHeight: number;
  activeActivity: 'explorer' | 'search' | 'analysis';
}

export const initialWorkspaceState: WorkspaceState = {
  groups: [{ id: 'group-main', tabs: [], activeFileId: null }],
  activeGroupId: 'group-main',
  explorerVisible: true,
  graphVisible: true,
  bottomPanelVisible: true,
  bottomPanelHeight: 190,
  activeActivity: 'explorer'
};
