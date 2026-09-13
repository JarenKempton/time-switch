import { useEffect, useState } from "react";

export type Route = "dashboard" | "history" | "settings";

const ROUTES: Route[] = ["dashboard", "history", "settings"];

function read(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  return ROUTES.includes(hash as Route) ? (hash as Route) : "dashboard";
}

export function navigate(route: Route): void {
  window.location.hash = route === "dashboard" ? "" : `/${route}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
