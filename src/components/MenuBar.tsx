import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Command, Search } from 'lucide-react';

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
  action?: () => void;
}

export interface MenuDefinition {
  label: string;
  items: MenuItem[];
}

export function MenuBar({ menus, onSearch }: { menus: MenuDefinition[]; onSearch(value: string): void }) {
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  return (
    <div className="titlebar" ref={root}>
      <div className="brand"><span className="brand-mark"><Command size={15} /></span><strong>ASM Graph Inspector</strong><span className="version-tag">next</span></div>
      <nav className="menubar" aria-label="Application menu">
        {menus.map((menu) => (
          <div className="menu-wrap" key={menu.label}>
            <button className={open === menu.label ? 'menu-trigger active' : 'menu-trigger'} onClick={() => setOpen((current) => current === menu.label ? null : menu.label)}>{menu.label}<ChevronDown size={12} /></button>
            {open === menu.label ? (
              <div className="menu-popover">
                {menu.items.map((item, index) => item.separator ? <div className="menu-separator" key={`${menu.label}-${index}`} /> : (
                  <button key={`${menu.label}-${item.label}`} disabled={item.disabled} onClick={() => { setOpen(null); item.action?.(); }}>
                    <span>{item.label}</span>{item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </nav>
      <label className="global-search">
        <Search size={14} />
        <input placeholder="Search files or symbols…" onChange={(event) => onSearch(event.target.value)} />
        <kbd>Ctrl K</kbd>
      </label>
    </div>
  );
}
