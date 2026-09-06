import { Boxes, Github } from 'lucide-react';
import { Modal } from './ui';

export function AboutDialog({ onClose }: { onClose(): void }) {
  return (
    <Modal title="About ASM Graph Inspector" onClose={onClose} width={620}>
      <div className="about-dialog">
        <div className="about-logo"><Boxes size={32} /></div>
        <h3>ASM Graph Inspector</h3>
        <p>A browser-native workspace for ASM, ELF, graph exploration and execution-model tooling.</p>
        <div className="about-facts"><span>React + Vite + TypeScript</span><span>100% frontend</span><span>Canvas graph renderer</span><span>IndexedDB projects</span></div>
        <a href="https://github.com/MolikoDeveloper/asm-viewer-vibe-coded" target="_blank" rel="noreferrer"><Github size={16} /> GitHub repository</a>
      </div>
    </Modal>
  );
}
