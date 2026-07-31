import type { ReactNode } from 'react';
import { IconClose } from './icons';

interface Props {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}

/* Right-side drawer used by the redirect & rewrite editors. */
export default function Drawer({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: Props) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="drawer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="sub">{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <IconClose size={18} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        <div className="drawer-foot">{footer}</div>
      </div>
    </div>
  );
}
