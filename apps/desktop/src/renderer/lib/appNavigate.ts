import type { NavigateFunction } from "react-router-dom";

let nav: NavigateFunction | null = null;

export function bindAppNavigate(fn: NavigateFunction | null): void {
  nav = fn;
}

export function appNavigate(to: string): void {
  if (nav) {
    nav(to);
    return;
  }
  const path = to.startsWith("/") ? to : `/${to}`;
  window.location.hash = `#${path}`;
}
