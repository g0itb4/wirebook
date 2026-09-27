// The address of a page is the name of what it shows: `#/package.Message`,
// `#/package.Service`, `#/package.Service/Method`. A link survives a rebuild
// of the site for as long as the declaration keeps its name.
import type { EnumDoc, Index, MessageDoc, MethodDoc, ServiceDoc } from "./types";

export type Route =
  | { kind: "home" }
  | { kind: "service"; service: ServiceDoc }
  | { kind: "method"; service: ServiceDoc; method: MethodDoc }
  | { kind: "message"; message: MessageDoc }
  | { kind: "enum"; enumeration: EnumDoc }
  | { kind: "missing"; target: string };

export function href(name: string): string {
  return `#/${name}`;
}

export function resolve(index: Index, hash: string): Route {
  let target = hash.replace(/^#\/?/, "");
  try {
    target = decodeURIComponent(target);
  } catch {
    // A stray percent sign: look the text up as it is.
  }
  if (target === "") return { kind: "home" };

  const slash = target.indexOf("/");
  if (slash >= 0) {
    const service = index.services.find((s) => s.name === target.slice(0, slash));
    const method = service?.methods.find((m) => m.name === target.slice(slash + 1));
    return service && method ? { kind: "method", service, method } : { kind: "missing", target };
  }
  const service = index.services.find((s) => s.name === target);
  if (service) return { kind: "service", service };
  const message = index.messages.find((m) => m.name === target);
  if (message) return { kind: "message", message };
  const enumeration = index.enums.find((e) => e.name === target);
  if (enumeration) return { kind: "enum", enumeration };
  return { kind: "missing", target };
}

/** What the tab is called on a page. */
export function title(route: Route, site: string): string {
  switch (route.kind) {
    case "home":
      return site;
    case "service":
      return `${shortName(route.service.name)} · ${site}`;
    case "method":
      return `${route.method.name} · ${site}`;
    case "message":
      return `${shortName(route.message.name)} · ${site}`;
    case "enum":
      return `${shortName(route.enumeration.name)} · ${site}`;
    case "missing":
      return `Not found · ${site}`;
  }
}

/** `Widget.Part` of `fixture.v1.Widget.Part`, given its package. */
export function shortName(fullName: string, pkg?: string): string {
  if (pkg !== undefined && pkg !== "" && fullName.startsWith(`${pkg}.`)) {
    return fullName.slice(pkg.length + 1);
  }
  return fullName.slice(fullName.lastIndexOf(".") + 1);
}

export interface PackageGroup {
  name: string;
  imported: boolean;
  services: ServiceDoc[];
  messages: MessageDoc[];
  enums: EnumDoc[];
}

/**
 * The navigation: one group per package, the site's own packages first, in
 * the order their files come, then the packages it only imports.
 */
export function packages(index: Index): PackageGroup[] {
  const packageOf = new Map(index.files.map((file) => [file.name, file.package]));
  const groups = new Map<string, PackageGroup>();
  const group = (file: string, imported: boolean): PackageGroup => {
    const name = packageOf.get(file) ?? "";
    let found = groups.get(name);
    if (!found) {
      found = { name, imported: true, services: [], messages: [], enums: [] };
      groups.set(name, found);
    }
    // A package is the site's own when any of its files is.
    found.imported &&= imported;
    return found;
  };
  for (const service of index.services) group(service.file, service.imported).services.push(service);
  for (const message of index.messages) group(message.file, message.imported).messages.push(message);
  for (const enumeration of index.enums) group(enumeration.file, enumeration.imported).enums.push(enumeration);
  const all = [...groups.values()];
  return [...all.filter((g) => !g.imported), ...all.filter((g) => g.imported)];
}

/**
 * A function that shortens a full name by the package it is declared in:
 * `Widget.Part` for `fixture.v1.Widget.Part`. A name the schema does not
 * declare keeps its last part.
 */
export function namer(index: Index): (fullName: string) => string {
  const packageOfFile = new Map(index.files.map((file) => [file.name, file.package]));
  const packageOf = new Map<string, string>();
  for (const declared of [...index.services, ...index.messages, ...index.enums]) {
    packageOf.set(declared.name, packageOfFile.get(declared.file) ?? "");
  }
  return (fullName) => shortName(fullName, packageOf.get(fullName));
}
