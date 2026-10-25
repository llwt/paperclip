import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** The staged helper binary, or null when it could not be built here. */
    scopeHelper: string | null;
    scopeHelperSkipReason: string | null;
    /** An owned, uniquely named test slice; teardown stops it. */
    testSlice: string;
    /** Why real user manager tests are skipped, or null when they run. */
    systemdSkipReason: string | null;
  }
}
