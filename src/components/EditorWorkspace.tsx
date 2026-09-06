import { Columns2, FileQuestion, X } from 'lucide-react';
import type { InspectorProject, ProjectFile } from '../features/project/model';
import type { EditorGroupState } from '../features/workspace/model';
import { EmptyState, IconButton } from './ui';
import { SourceEditor } from './SourceEditor';

function EditorGroup({ group, filesById, active, fontSize, compactTabs, onActivateGroup, onActivateFile, onCloseTab, onCloseGroup, onChangeText, onSplit }: {
  group: EditorGroupState;
  filesById: Map<string, ProjectFile>;
  active: boolean;
  fontSize: number;
  compactTabs: boolean;
  onActivateGroup(): void;
  onActivateFile(fileId: string): void;
  onCloseTab(fileId: string): void;
  onCloseGroup?: () => void;
  onChangeText(fileId: string, text: string): void;
  onSplit(): void;
}) {
  const activeFile = group.activeFileId ? filesById.get(group.activeFileId) ?? null : null;
  return (
    <section className={active ? 'editor-group active' : 'editor-group'} onMouseDown={onActivateGroup}>
      <div className={compactTabs ? 'editor-tabs compact' : 'editor-tabs'}>
        <div className="tab-strip">
          {group.tabs.map((fileId) => {
            const file = filesById.get(fileId);
            if (!file) return null;
            return (
              <div key={fileId} className={group.activeFileId === fileId ? 'editor-tab active' : 'editor-tab'}>
                <button className="editor-tab-main" onClick={() => onActivateFile(fileId)} title={file.path}>{file.name}</button>
                <button className="tab-close" aria-label={`Close ${file.name}`} onClick={(event) => { event.stopPropagation(); onCloseTab(fileId); }}><X size={13} /></button>
              </div>
            );
          })}
        </div>
        <div className="editor-group-actions"><IconButton title="Split editor right" aria-label="Split editor right" onClick={onSplit}><Columns2 size={15} /></IconButton>{onCloseGroup ? <IconButton title="Close editor group" aria-label="Close editor group" onClick={onCloseGroup}><X size={15} /></IconButton> : null}</div>
      </div>
      <div className="editor-surface">
        {activeFile ? <SourceEditor file={activeFile} fontSize={fontSize} onChange={(text) => onChangeText(activeFile.id, text)} onFocus={onActivateGroup} /> : <EmptyState icon={<FileQuestion size={28} />} title="No file open" body="Open a file from the Explorer or File menu." />}
      </div>
    </section>
  );
}

export function EditorWorkspace({ project, groups, activeGroupId, fontSize, compactTabs, onActivateGroup, onActivateFile, onCloseTab, onCloseGroup, onChangeText, onSplit }: {
  project: InspectorProject;
  groups: EditorGroupState[];
  activeGroupId: string;
  fontSize: number;
  compactTabs: boolean;
  onActivateGroup(groupId: string): void;
  onActivateFile(groupId: string, fileId: string): void;
  onCloseTab(groupId: string, fileId: string): void;
  onCloseGroup(groupId: string): void;
  onChangeText(fileId: string, text: string): void;
  onSplit(): void;
}) {
  const filesById = new Map(project.files.map((file) => [file.id, file]));
  return (
    <div className={`editor-workspace groups-${groups.length}`}>
      {groups.map((group) => (
        <EditorGroup
          key={group.id}
          group={group}
          filesById={filesById}
          active={group.id === activeGroupId}
          fontSize={fontSize}
          compactTabs={compactTabs}
          onActivateGroup={() => onActivateGroup(group.id)}
          onActivateFile={(fileId) => onActivateFile(group.id, fileId)}
          onCloseTab={(fileId) => onCloseTab(group.id, fileId)}
          onCloseGroup={groups.length > 1 ? () => onCloseGroup(group.id) : undefined}
          onChangeText={onChangeText}
          onSplit={onSplit}
        />
      ))}
    </div>
  );
}
