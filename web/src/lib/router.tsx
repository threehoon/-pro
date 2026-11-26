import { useCallback, useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from "react";

const NAV_EVENT = "hl:navigate";

export function currentPath(): string {
  return window.location.pathname || "/";
}

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (to === currentLocation()) return;
  if (options.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAV_EVENT));
  if (!to.includes("#")) window.scrollTo(0, 0);
}

export function usePathname(): string {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    const update = () => setPath(currentPath());
    window.addEventListener("popstate", update);
    window.addEventListener(NAV_EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(NAV_EVENT, update);
    };
  }, []);

  return path;
}

function currentLocation() {
  return `${currentPath()}${window.location.search}${window.location.hash}`;
}

export function useLocation() {
  const [location, setLocation] = useState(currentLocation);
  useEffect(() => {
    const update = () => setLocation(currentLocation());
    const events = ["popstate", "hashchange", NAV_EVENT];
    events.forEach((event) => window.addEventListener(event, update));
    return () => events.forEach((event) => window.removeEventListener(event, update));
  }, []);
  return location;
}

export function useNavigate() {
  return useCallback((to: string, options?: { replace?: boolean }) => navigate(to, options), []);
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  children: ReactNode;
}

export function Link({ to, children, onClick, ...rest }: LinkProps) {
  return (
    <a
      href={to}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onClick?.(event);
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export interface RouteMatch {
  path: string;
  params: Record<string, string>;
}

export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const patternPart = patternParts[i] as string;
    const pathPart = pathParts[i] as string;
    if (patternPart.startsWith(":")) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}
