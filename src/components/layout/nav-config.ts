import {
  LayoutDashboard,
  ShieldAlert,
  Network,
  Radar,
  FlaskConical,
  Wrench,
  TrendingUp,
  Users,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
}






export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Overview', href: '/', icon: LayoutDashboard, description: 'Repository health at a glance' },
  { label: 'Analysis', href: '/analysis', icon: ShieldAlert, description: 'All findings by category' },
  { label: 'Codebase', href: '/codebase', icon: Network, description: 'Architecture and dependencies' },
  { label: 'Guardian', href: '/guardian', icon: Radar, description: 'GitHub automation and policies' },
  { label: 'Testing', href: '/testing', icon: FlaskConical, description: 'Coverage and test gaps' },
  { label: 'Fix Center', href: '/fixes', icon: Wrench, description: 'Review and apply fixes' },
  { label: 'Insights', href: '/insights', icon: TrendingUp, description: 'Trends and technical debt' },
  { label: 'Team', href: '/team', icon: Users, description: 'Access and collaboration' },
  { label: 'Settings', href: '/settings', icon: Settings, description: 'Configuration and integrations' },
] as const;
