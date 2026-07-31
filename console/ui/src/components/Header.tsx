import { Link, useNavigate } from 'react-router-dom';
import Brand from './Brand';
import DistributionChip from './DistributionChip';
import type { Distribution } from '../types';

interface Props {
  distributions: Distribution[];
  current: Distribution;
  onSelectDistribution: (id: string) => void;
  onAddDistribution: () => void;
  onOpenSettings: () => void;
}

/* Ticket: Front — SPA scaffold (header) + distribution switcher (switch / add /
   settings). */
export default function Header({
  distributions,
  current,
  onSelectDistribution,
  onAddDistribution,
  onOpenSettings,
}: Props) {
  const navigate = useNavigate();
  return (
    <div className="appbar">
      <Link to="/">
        <Brand />
      </Link>
      <div style={{ width: 1, height: 26, background: 'rgba(255,255,255,0.12)' }} />
      <DistributionChip
        distributions={distributions}
        current={current}
        onSelect={onSelectDistribution}
        onAdd={onAddDistribution}
        onOpenSettings={onOpenSettings}
      />
      <div className="appbar-spacer" />
      <div className="appbar-user">
        <span className="avatar">FF</span>
        <span>fabrice@trackit.io</span>
      </div>
      <button className="btn btn-dark btn-sm" onClick={() => navigate('/login')}>
        Log out
      </button>
    </div>
  );
}
