// The app pages present in this build, so the navigation never links to a page that is not there.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every /app route with a page, or null when the folder cannot be read (then every link is shown). */
export function appRoutes(): string[] | null {
  const dir = join(process.cwd(), "src", "app", "app");
  try {
    const pages = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "page.tsx")))
      .map((e) => `/app/${e.name}`);
    return ["/app", ...pages];
  } catch {
    return null;
  }
}
