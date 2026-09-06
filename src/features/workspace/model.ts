export interface EditorRevealTarget {
  fileId: string;
  line?: number;
  address?: number;
  nonce: number;
}

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
  sidebarWidth: number;
  analysisWidth: number;
  activeActivity: 'explorer' | 'search';
}

export const initialWorkspaceState: WorkspaceState = {
  groups: [{ id: 'group-main', tabs: [], activeFileId: null }],
  activeGroupId: 'group-main',
  explorerVisible: true,
  graphVisible: true,
  bottomPanelVisible: true,
  bottomPanelHeight: 190,
  sidebarWidth: 232,
  analysisWidth: 620,
  activeActivity: 'explorer'
};
