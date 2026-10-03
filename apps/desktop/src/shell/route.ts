import { features, type FeatureRoute } from "@/app/routes";

/** Transition key: the top-level section, so navigation inside a feature doesn't re-animate the page. */
export function sectionKey(pathname: string): string {
  return pathname.split("/").filter(Boolean)[0] ?? "home";
}

/** Navigable path of a feature ("/tasks/*" → "/tasks"). */
export function featurePath(f: FeatureRoute): string {
  return f.path.replace("/*", "") || "/";
}

/** The feature owning a location (for the top bar section label). */
export function featureForPath(pathname: string): FeatureRoute | undefined {
  const key = sectionKey(pathname);
  return features.find((f) => sectionKey(featurePath(f)) === key);
}
