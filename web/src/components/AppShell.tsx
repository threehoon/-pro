import { useEffect, useState, type ReactNode } from "react";
import { Link, usePathname } from "../lib/router";
import type { SessionUser } from "../types";
import { Avatar, IconButton } from "./ui";
import {
  IconBell,
  IconBriefcase,
  IconCalendar,
  IconDashboard,
  IconMoon,
  IconSettings,
  IconSun,
  IconUsers,
  IconX,
} from "./icons";

const NAV = [
  { to: "/", label: "工作台", icon: IconDashboard, match: (path: string) => path === "/" },
  { to: "/jobs", label: "职位", icon: IconBriefcase, match: (path: string) => path.startsWith("/jobs") },
  { to: "/candidates", label: "候选人", icon: IconUsers, match: (path: string) => path.startsWith("/candidates") },
  { to: "/interviews", label: "面试", icon: IconCalendar, match: (path: string) => path.startsWith("/interviews") },
  { to: "/settings", label: "设置", icon: IconSettings, match: (path: string) => path.startsWith("/settings") },
];

export function AppShell({
  user,
  children,
  unread,
}: {
  user: SessionUser;
  children: ReactNode;
  unread?: number;
}) {
  const path = usePathname();
  const [dark, setDark] = useState(() => document.documentElement.getAttribute("data-theme") === "dark");
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("hl-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => setMobileOpen(false), [path]);

  return (
    <div className={`shell ${mobileOpen ? "nav-open" : ""}`}>
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M4 6.5c4.5 0 4.5 11 9.5 11S20 6.5 20 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <circle cx="4" cy="6.5" r="1.8" fill="currentColor" />
              <circle cx="20" cy="6.5" r="1.8" fill="currentColor" />
            </svg>
          </span>
          <div className="brand-text">
            <strong>Hireloop</strong>
            <span>招聘工作台</span>
          </div>
          <IconButton label="关闭菜单" className="sidebar-close" onClick={() => setMobileOpen(false)}>
            <IconX size={18} />
          </IconButton>
        </div>

        <nav className="nav" aria-label="主导航">
          {NAV.map((item) => {
            const active = item.match(path);
            const Icon = item.icon;
            return (
              <Link key={item.to} to={item.to} className={`nav-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}>
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <button type="button" className="theme-toggle" onClick={() => setDark((value) => !value)}>
            {dark ? <IconSun size={16} /> : <IconMoon size={16} />}
            <span>{dark ? "浅色模式" : "深色模式"}</span>
          </button>
          <Link to="/settings" className="user-chip" aria-label="账户设置">
            <Avatar name={user.name} size={30} chars={1} />
            <span className="user-chip-text">
              <strong>{user.name}</strong>
              <small>{roleText(user.role)}</small>
            </span>
          </Link>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <button type="button" className="menu-btn" onClick={() => setMobileOpen(true)} aria-label="打开菜单">
            <span />
            <span />
            <span />
          </button>
          <div className="topbar-crumb">
            <span className="crumb-muted">招聘工作台</span>
            <span className="crumb-sep">/</span>
            <span>{currentLabel(path)}</span>
          </div>
          <div className="topbar-right">
            <Link
              to="/settings"
              className="bell"
              aria-label={unread ? `通知与飞书待办，${unread} 条待处理` : "通知与飞书待办"}
              title={unread ? `${unread} 条待处理通知` : "暂无待处理通知"}
            >
              <IconBell size={18} />
              {unread ? <span className="bell-dot" aria-hidden /> : null}
            </Link>
          </div>
        </header>
        <main id="main" className="content">
          {children}
        </main>
      </div>
      {mobileOpen && <div className="nav-scrim" onClick={() => setMobileOpen(false)} aria-hidden />}
    </div>
  );
}

function currentLabel(path: string): string {
  if (path === "/") return "工作台";
  if (path.startsWith("/jobs")) return "职位";
  if (path.startsWith("/candidates")) return "候选人";
  if (path.startsWith("/interviews")) return "面试";
  if (path.startsWith("/settings")) return "设置";
  return "工作台";
}

function roleText(role: SessionUser["role"]): string {
  if (role === "admin") return "管理员";
  if (role === "hiring_manager") return "用人经理";
  return "招聘";
}
