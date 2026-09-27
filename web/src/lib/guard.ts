// A page that holds credentials and sends requests on a click must not run
// inside another site's frame: that site could lay its own picture over this
// one and have the visitor click "Send" without seeing it.
//
// The header that forbids framing (`frame-ancestors`) cannot be set from a
// page, and a static host may not send it. This check does not depend on the
// host.

interface Frame {
  top: unknown;
  self: unknown;
  location: { origin: string };
}

/** Whether the page is in a frame of a site that is not its own. */
export function framedByAnotherSite(window: Frame): boolean {
  if (window.top === window.self) return false;
  try {
    // Reading the origin of a frame on another site throws.
    return (window.top as Frame).location.origin !== window.location.origin;
  } catch {
    return true;
  }
}
